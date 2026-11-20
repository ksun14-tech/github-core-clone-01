// A dependency-free git object store and packfile implementation: loose-object hashing, commit and
// tree parsing and formatting, reachability, pack writing and pack reading with delta resolution.
// Only node: builtins, so the trial's no-dependency rule holds.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const TYPE_IDS: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: readonly GitObjectType[] = ['', 'commit', 'tree', 'blob', 'tag'] as unknown as readonly GitObjectType[];

/** The SHA-1 id of an object: sha1 of "<type> <length>\0" followed by the raw bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putWithOid(oid: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// ------------------------------------------------------------------ commits and trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function formatCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.toString('ascii', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with directories compared as if they had a trailing slash. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function formatTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface FileSlot {
  oid: string;
  mode: string;
}

/** Build (and store) the tree hierarchy for a flat path -> blob map; returns the root tree oid. */
export function buildTree(store: ObjectStore, files: ReadonlyMap<string, FileSlot>): string {
  interface Dir {
    files: Map<string, FileSlot>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, slot] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = dir.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(parts[i], next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1], slot);
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, slot] of dir.files) entries.push({ mode: slot.mode, name, oid: slot.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
    return store.put('tree', formatTree(entries));
  };
  return emit(root);
}

/** Flatten a tree into path -> slot, recursively. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = ''): Map<string, FileSlot> {
  const out = new Map<string, FileSlot>();
  const object = store.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '40000') {
      for (const [path, slot] of flattenTree(store, entry.oid, `${prefix}${entry.name}/`)) out.set(path, slot);
    } else {
      out.set(`${prefix}${entry.name}`, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

// ------------------------------------------------------------------ reachability

/** Every object reachable from the given commit/tag tips (commits, their trees and blobs). */
export function reachableObjects(store: ObjectStore, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) if (store.has(tip)) stack.push(tip);
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = /object ([0-9a-f]{40})/.exec(object.data.toString('utf8'));
      if (target) stack.push(target[1]);
    }
  }
  return seen;
}

/** Commit-only ancestry: every commit reachable from the tips. */
export function commitAncestry(store: ObjectStore, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      const target = /object ([0-9a-f]{40})/.exec(object.data.toString('utf8'));
      if (target) stack.push(target[1]);
      continue;
    }
    if (object.type !== 'commit') continue;
    seen.add(oid);
    stack.push(...parseCommit(object.data).parents);
  }
  return seen;
}

/** Peel a tag (or return the commit itself) down to its commit oid, or null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = store.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const target = /object ([0-9a-f]{40})/.exec(object.data.toString('utf8'));
    if (!target) return null;
    current = target[1];
  }
  return null;
}

export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitAncestry(store, [descendant]).has(ancestor);
}

/** A merge base of two commits: a common ancestor with the greatest generation depth, or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsA = commitAncestry(store, [a]);
  if (ancestorsA.has(b)) return b;
  if (commitAncestry(store, [b]).has(a)) return a;
  // Breadth-first from b; the first commit also ancestral to a is a merge base.
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = store.get(oid);
    if (object && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** Generation distance (tip = 1) of every commit reachable from the tips. */
export function commitDistances(store: ObjectStore, tips: readonly string[]): Map<string, number> {
  const distance = new Map<string, number>();
  let frontier: string[] = [];
  for (const tip of tips) {
    const commit = peelToCommit(store, tip);
    if (commit && !distance.has(commit)) {
      distance.set(commit, 1);
      frontier.push(commit);
    }
  }
  let depth = 1;
  while (frontier.length) {
    depth += 1;
    const next: string[] = [];
    for (const oid of frontier) {
      const object = store.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, depth);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return distance;
}

// ------------------------------------------------------------------ packfiles

/** Serialize the given objects into a packfile v2 (no deltas), with its trailing SHA-1. */
export function buildPack(store: ObjectStore, oids: Iterable<string>): Buffer {
  const list = [...oids].filter((oid) => store.has(oid));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const object = store.get(oid) as GitObject;
    const size = object.data.length;
    const typeId = TYPE_IDS[object.type];
    const bytes: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    let rest = Math.floor(size / 16);
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest = Math.floor(rest / 128);
      if (rest > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate the zlib stream starting at `offset`; resolves with the data and the bytes consumed.
 * Node's zlib does not report how much input a stream consumed, so the stream's exact end is
 * found by binary search: inflateSync succeeds on the full stream and on any longer prefix
 * (trailing bytes are ignored), and fails on every shorter one.
 */
export function inflateAt(buffer: Buffer, offset: number): Promise<{ data: Buffer; consumed: number }> {
  const maxLength = buffer.length - offset;
  const data = inflateSync(buffer.subarray(offset));
  let low = 1;
  let high = maxLength;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    let ok = true;
    try {
      inflateSync(buffer.subarray(offset, offset + mid));
    } catch {
      ok = false;
    }
    if (ok) high = mid;
    else low = mid + 1;
  }
  return Promise.resolve({ data, consumed: low });
}

/** Apply a git delta buffer to its base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos]; pos += 1; }
      if (op & 0x02) { offset |= delta[pos] << 8; pos += 1; }
      if (op & 0x04) { offset |= delta[pos] << 16; pos += 1; }
      if (op & 0x08) { offset |= delta[pos] << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos]; pos += 1; }
      if (op & 0x20) { size |= delta[pos] << 8; pos += 1; }
      if (op & 0x40) { size |= delta[pos] << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface PackedObject {
  type: GitObjectType;
  data: Buffer;
}

/**
 * Parse a packfile, resolving ofs-delta and ref-delta chains, into plain objects in pack order.
 * Throws on a malformed pack or a checksum mismatch.
 */
export async function parsePack(pack: Buffer): Promise<PackedObject[]> {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');

  interface RawEntry {
    typeId: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    start: number;
  }
  const raw: RawEntry[] = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    let byte = pack[pos];
    pos += 1;
    const typeId = (byte >> 4) & 7;
    while (byte & 0x80) {
      byte = pack[pos];
      pos += 1;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeId === 6) {
      let byte2 = pack[pos];
      pos += 1;
      let offset = byte2 & 0x7f;
      while (byte2 & 0x80) {
        byte2 = pack[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (byte2 & 0x7f);
      }
      baseOffset = start - offset;
    } else if (typeId === 7) {
      baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const { data, consumed } = await inflateAt(pack, pos);
    pos += consumed;
    raw.push({ typeId, data, baseOffset, baseOid, start });
  }

  const byOffset = new Map<number, number>();
  raw.forEach((entry, index) => byOffset.set(entry.start, index));
  const resolved: (PackedObject | undefined)[] = new Array(raw.length).fill(undefined);
  const external = new Map<string, PackedObject>();

  const resolveEntry = (index: number, externalObjects: ReadonlyMap<string, GitObject>): PackedObject => {
    const memo = resolved[index];
    if (memo) return memo;
    const entry = raw[index];
    let result: PackedObject;
    if (entry.typeId >= 1 && entry.typeId <= 4) {
      result = { type: ID_TYPES[entry.typeId], data: entry.data };
    } else if (entry.typeId === 6) {
      const baseIndex = byOffset.get(entry.baseOffset as number);
      if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolveEntry(baseIndex, externalObjects);
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeId === 7) {
      const baseOid = entry.baseOid as string;
      let base = external.get(baseOid);
      if (!base) {
        const found = externalObjects.get(baseOid);
        if (!found) throw new Error(`ref-delta base ${baseOid} not available`);
        base = { type: found.type, data: found.data };
        external.set(baseOid, base);
      }
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      throw new Error(`unknown pack object type ${entry.typeId}`);
    }
    resolved[index] = result;
    return result;
  };

  return raw.map((_, index) => resolveEntry(index, new Map()));
}

/**
 * Parse a packfile into the store, resolving ref-deltas against objects already in the store.
 * Returns the oids written (or already present).
 */
export async function unpackInto(store: ObjectStore, pack: Buffer): Promise<string[]> {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  interface RawEntry {
    typeId: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    start: number;
  }
  const raw: RawEntry[] = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    let byte = pack[pos];
    pos += 1;
    const typeId = (byte >> 4) & 7;
    while (byte & 0x80) {
      byte = pack[pos];
      pos += 1;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeId === 6) {
      let byte2 = pack[pos];
      pos += 1;
      let offset = byte2 & 0x7f;
      while (byte2 & 0x80) {
        byte2 = pack[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (byte2 & 0x7f);
      }
      baseOffset = start - offset;
    } else if (typeId === 7) {
      baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const { data, consumed } = await inflateAt(pack, pos);
    pos += consumed;
    raw.push({ typeId, data, baseOffset, baseOid, start });
  }
  const byOffset = new Map<number, number>();
  raw.forEach((entry, index) => byOffset.set(entry.start, index));
  const resolved: (PackedObject | undefined)[] = new Array(raw.length).fill(undefined);
  const resolveEntry = (index: number): PackedObject => {
    const memo = resolved[index];
    if (memo) return memo;
    const entry = raw[index];
    let result: PackedObject;
    if (entry.typeId >= 1 && entry.typeId <= 4) {
      result = { type: ID_TYPES[entry.typeId], data: entry.data };
    } else if (entry.typeId === 6) {
      const baseIndex = byOffset.get(entry.baseOffset as number);
      if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolveEntry(baseIndex);
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeId === 7) {
      const baseOid = entry.baseOid as string;
      const found = store.get(baseOid);
      if (!found) throw new Error(`ref-delta base ${baseOid} not available`);
      result = { type: found.type, data: applyDelta(found.data, entry.data) };
    } else {
      throw new Error(`unknown pack object type ${entry.typeId}`);
    }
    resolved[index] = result;
    return result;
  };
  const oids: string[] = [];
  raw.forEach((_, index) => {
    const object = resolveEntry(index);
    oids.push(store.put(object.type, object.data));
  });
  return oids;
}
