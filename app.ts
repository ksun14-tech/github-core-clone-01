// A GitHub-compatible git forge in one file: REST v3 resources, GraphQL v4, an MCP endpoint and git
// smart HTTP (protocol v0 and v2), all over an in-memory object store (gitstore.ts). Node builtins
// only. The trial's scenario user is fixed data (the contest's seeded viewer), so the bearer token's
// account is that user; every other login's repositories are invisible to it (404, never 403).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ObjectStore,
  ZERO_OID,
  buildPack,
  buildTree,
  commitAncestry,
  commitDistances,
  flattenTree,
  formatCommit,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  reachableObjects,
  unpackInto,
  type FileSlot,
} from './gitstore.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestCounter = 0;

// ------------------------------------------------------------------ the forge's data

interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  pullRequest?: PullData;
}

interface PullData {
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

interface Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  store: ObjectStore;
  refs: Map<string, string>;
  labels: Label[];
  issues: Issue[];
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

const repos = new Map<string, Repo>();
let nextRepoId = 100000;
let nextObjectId = 500000;

function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function gitTimestamp(date = new Date()): string {
  return `${Math.floor(date.getTime() / 1000)} +0000`;
}

function createRepo(name: string, isPrivate: boolean, description = '', defaultBranch = 'main'): Repo {
  const repo: Repo = {
    id: nextRepoId++,
    name,
    owner: VIEWER.login,
    isPrivate,
    description,
    defaultBranch: defaultBranch || 'main',
    store: new ObjectStore(),
    refs: new Map(),
    labels: [],
    issues: [],
    nextNumber: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repos.set(repoKey(repo.owner, repo.name), repo);
  return repo;
}

function findRepo(owner: string, name: string): Repo | null {
  if (owner.toLowerCase() !== VIEWER.login) return null;
  return repos.get(repoKey(owner, name)) ?? null;
}

function headRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Create a commit in the repo from a full path map; returns the commit oid. */
function commitFiles(repo: Repo, files: Map<string, FileSlot>, message: string, parents: string[]): string {
  const tree = buildTree(repo.store, files);
  const stamp = gitTimestamp();
  const identity = `${VIEWER.name} <${VIEWER.email}> ${stamp}`;
  const raw = formatCommit({ tree, parents, author: identity, committer: identity, message });
  return repo.store.put('commit', raw);
}

/** The flattened file map at a commit (or an empty map for no commit). */
function filesAt(repo: Repo, commitOid: string | null): Map<string, FileSlot> {
  if (!commitOid) return new Map();
  const commit = repo.store.get(commitOid);
  if (!commit || commit.type !== 'commit') return new Map();
  return flattenTree(repo.store, parseCommit(commit.data).tree);
}

// ------------------------------------------------------------------ JSON shapes

function userShape(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: nodeId('User', VIEWER.id),
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    site_admin: false,
    avatar_url: 'https://forge.invalid/avatars/adaiversen',
    html_url: `https://forge.invalid/${VIEWER.login}`,
    url: `/api/v3/users/${VIEWER.login}`,
  };
}

function nodeId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userShape(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://forge.invalid/${repo.owner}/${repo.name}.git`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    fork: false,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => !issue.pullRequest && issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelShape(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: nodeId('Label', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: '',
  };
}

function commentShape(repo: Repo, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    body: comment.body,
    user: userShape(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    url: '',
    issue_url: '',
    author_association: 'OWNER',
    reactions: { total_count: 0 },
  };
}

function issueShape(repo: Repo, issue: Issue): Record<string, unknown> {
  const shape: Record<string, unknown> = {
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map(labelShape),
    user: userShape(),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    author_association: 'OWNER',
    reactions: { total_count: 0 },
  };
  if (issue.pullRequest) {
    shape.pull_request = {
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${issue.number}`,
      html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${issue.number}`,
      merged_at: issue.pullRequest.mergedAt,
    };
  }
  return shape;
}

function pullShape(repo: Repo, issue: Issue): Record<string, unknown> {
  const pull = issue.pullRequest as PullData;
  const mergeable = computeMergeable(repo, issue);
  const base = { ...issueShape(repo, issue) };
  delete base.pull_request;
  return {
    ...base,
    state: pull.merged ? 'closed' : issue.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merged_by: pull.merged ? userShape() : null,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: mergeable === null ? null : mergeable,
    mergeable_state: mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty',
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: pullFiles(repo, issue).length,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: branchTip(repo, pull.headRef) ?? pull.headSha,
      user: userShape(),
      repo: repoShape(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: branchTip(repo, pull.baseRef) ?? pull.baseSha,
      user: userShape(),
      repo: repoShape(repo),
    },
    _links: { self: { href: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${issue.number}` } },
  };
}

// ------------------------------------------------------------------ pull request merging

interface TreeDiffEntry {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

/** Line-level additions/deletions between two blobs, by longest common subsequence (bounded). */
function lineDelta(repo: Repo, beforeOid: string | null, afterOid: string | null): { additions: number; deletions: number } {
  const before = beforeOid ? repo.store.get(beforeOid)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
  const after = afterOid ? repo.store.get(afterOid)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
  const a = before.toString('utf8').split('\n');
  const b = after.toString('utf8').split('\n');
  if (a.length * b.length > 4_000_000) {
    return { additions: countLines(after), deletions: countLines(before) };
  }
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(dp[j], dp[j - 1]);
      diagonal = above;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

/** The changed paths of a pull request: merge-base tree versus head tree. */
function pullFiles(repo: Repo, issue: Issue): TreeDiffEntry[] {
  const pull = issue.pullRequest as PullData;
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(repo.store, baseSha, headSha);
  const beforeFiles = filesAt(repo, base);
  const afterFiles = filesAt(repo, headSha);
  const entries: TreeDiffEntry[] = [];
  const paths = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = beforeFiles.get(path);
    const after = afterFiles.get(path);
    if (before && after && before.oid === after.oid) continue;
    const status = !before ? 'added' : !after ? 'removed' : 'modified';
    const delta = lineDelta(repo, before?.oid ?? null, after?.oid ?? null);
    entries.push({
      filename: path,
      status,
      additions: delta.additions,
      deletions: delta.deletions,
      changes: delta.additions + delta.deletions,
      sha: after?.oid ?? before?.oid ?? ZERO_OID,
    });
  }
  return entries;
}

/** Three-way tree merge; returns the merged file map, or null on a conflict. */
function mergeTrees(repo: Repo, baseSha: string, headSha: string): Map<string, FileSlot> | null {
  const ancestor = mergeBase(repo.store, baseSha, headSha);
  const ancestorFiles = filesAt(repo, ancestor);
  const baseFiles = filesAt(repo, baseSha);
  const headFiles = filesAt(repo, headSha);
  const merged = new Map<string, FileSlot>();
  const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const a = ancestorFiles.get(path)?.oid ?? null;
    const b = baseFiles.get(path)?.oid ?? null;
    const h = headFiles.get(path)?.oid ?? null;
    if (b === h) {
      if (b) merged.set(path, baseFiles.get(path) as FileSlot);
    } else if (a === b) {
      if (h) merged.set(path, headFiles.get(path) as FileSlot);
    } else if (a === h) {
      if (b) merged.set(path, baseFiles.get(path) as FileSlot);
    } else {
      return null;
    }
  }
  return merged;
}

function computeMergeable(repo: Repo, issue: Issue): boolean | null {
  const pull = issue.pullRequest;
  if (!pull || pull.merged) return null;
  const headSha = branchTip(repo, pull.headRef);
  const baseSha = branchTip(repo, pull.baseRef);
  if (!headSha || !baseSha) return null;
  return mergeTrees(repo, baseSha, headSha) !== null;
}

/** Perform the merge (or squash) of a pull request; returns the new commit oid or null on conflict. */
function performMerge(repo: Repo, issue: Issue, method: string): string | null {
  const pull = issue.pullRequest as PullData;
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const mergedFiles = mergeTrees(repo, baseSha, headSha);
  if (!mergedFiles) return null;
  let sha: string;
  if (method === 'squash') {
    sha = commitFiles(repo, mergedFiles, `${issue.title} (#${issue.number})`, [baseSha]);
  } else if (method === 'rebase') {
    sha = commitFiles(repo, mergedFiles, `${issue.title} (#${issue.number})`, [baseSha]);
  } else {
    sha = commitFiles(repo, mergedFiles, `Merge pull request #${issue.number} from ${pull.headRef}`, [baseSha, headSha]);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  issue.state = 'closed';
  issue.updatedAt = nowIso();
  repo.updatedAt = nowIso();
  return sha;
}

// ------------------------------------------------------------------ HTTP plumbing

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}`,
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}`,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  if (TOKEN === '') return header.startsWith('Bearer ') || header.startsWith('token ');
  return header === `Bearer ${TOKEN}` || header === `token ${TOKEN}`;
}

function hasAuthHeader(req: IncomingMessage): boolean {
  return typeof req.headers.authorization === 'string' && req.headers.authorization.length > 0;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function notFound(message = 'Not Found'): HttpError {
  return new HttpError(404, message);
}

/** Parse a JSON request body; a malformed body is the protocol check's 400. */
function jsonBody(raw: Buffer): Record<string, unknown> {
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'Problems parsing JSON');
  return parsed as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function pagination(req: IncomingMessage, url: URL): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  return { page, perPage };
}

function pageSlice<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(req: IncomingMessage, url: URL, total: number, page: number, perPage: number): Record<string, string> {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page >= lastPage) return {};
  const host = req.headers.host ?? 'forge.invalid';
  const base = `http://${host}${url.pathname}`;
  const next = new URLSearchParams(url.searchParams);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  const last = new URLSearchParams(url.searchParams);
  last.set('page', String(lastPage));
  last.set('per_page', String(perPage));
  return { link: `<${base}?${next.toString()}>; rel="next", <${base}?${last.toString()}>; rel="last"` };
}

// ------------------------------------------------------------------ REST v3

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, rawBody: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname.replace(/^\/api\/v3/, '') || '/';

  if (!authorized(req)) {
    if (!hasAuthHeader(req)) throw new HttpError(401, 'Requires authentication');
    throw new HttpError(401, 'Bad credentials');
  }

  if (method === 'GET' && path === '/') {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && path === '/meta') {
    sendJson(res, 200, {
      installed_version: '1.0.0-forge',
      git: { http: true, ssh: false },
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
      code_scanning: [],
      packages_registry: [],
      hooks: [],
      blocks: [],
    });
    return;
  }
  if (method === 'GET' && path === '/rate_limit') {
    sendJson(res, 200, { rate: { limit: 5000, remaining: 4999, reset: 1893456000, used: 1 }, resources: {} });
    return;
  }
  if (method === 'GET' && path === '/user') {
    sendJson(res, 200, userShape());
    return;
  }
  if (method === 'POST' && path === '/user/repos') {
    const body = jsonBody(rawBody);
    const name = str(body.name);
    if (!name) throw new HttpError(422, 'Repository creation failed: name is required');
    if (repos.has(repoKey(VIEWER.login, name))) throw new HttpError(422, 'Repository creation failed: name already exists on this account');
    const repo = createRepo(name, body.private === true, str(body.description), str(body.default_branch) || 'main');
    sendJson(res, 201, repoShape(repo));
    return;
  }
  if (method === 'GET' && path === '/user/repos') {
    const { page, perPage } = pagination(req, url);
    const mine = [...repos.values()].filter((repo) => repo.owner === VIEWER.login);
    sendJson(res, 200, pageSlice(mine, page, perPage).map(repoShape), linkHeader(req, url, mine.length, page, perPage));
    return;
  }

  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (repoMatch) {
    const owner = decodeURIComponent(repoMatch[1]);
    const name = decodeURIComponent(repoMatch[2]);
    const rest = repoMatch[3] ?? '';
    const repo = findRepo(owner, name);
    if (!repo) throw notFound();
    await handleRepoRest(req, res, url, rawBody, repo, rest);
    return;
  }

  throw notFound();
}

async function handleRepoRest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rawBody: Buffer,
  repo: Repo,
  rest: string,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (rest === '' || rest === '/') {
    if (method === 'GET') {
      sendJson(res, 200, repoShape(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = jsonBody(rawBody);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch) repo.defaultBranch = body.default_branch;
      if (typeof body.name === 'string' && body.name && body.name !== repo.name) {
        repos.delete(repoKey(repo.owner, repo.name));
        repo.name = body.name;
        repos.set(repoKey(repo.owner, repo.name), repo);
      }
      repo.updatedAt = nowIso();
      sendJson(res, 200, repoShape(repo));
      return;
    }
    if (method === 'DELETE') {
      repos.delete(repoKey(repo.owner, repo.name));
      sendJson(res, 204, undefined);
      return;
    }
    throw notFound();
  }

  if (rest === '/branches' && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
        protected: false,
      }));
    sendJson(res, 200, branches);
    return;
  }
  const branchMatch = /^\/branches\/(.+)$/.exec(rest);
  if (branchMatch && method === 'GET') {
    const branch = decodeURIComponent(branchMatch[1]);
    const sha = branchTip(repo, branch);
    if (!sha) throw notFound('Branch not found');
    sendJson(res, 200, {
      name: branch,
      commit: commitShape(repo, sha),
      protected: false,
      _links: { self: { href: `/api/v3/repos/${repo.owner}/${repo.name}/branches/${branch}` } },
    });
    return;
  }

  if (rest === '/commits' && method === 'GET') {
    const refParam = url.searchParams.get('sha');
    let start: string | null;
    if (refParam) {
      start = branchTip(repo, refParam) ?? (repo.store.has(refParam) ? refParam : null);
    } else {
      start = branchTip(repo, repo.defaultBranch);
    }
    if (!start) {
      sendJson(res, 200, []);
      return;
    }
    const { page, perPage } = pagination(req, url);
    const ordered = orderCommits(repo, start);
    sendJson(res, 200, pageSlice(ordered, page, perPage).map((sha) => commitShape(repo, sha)), linkHeader(req, url, ordered.length, page, perPage));
    return;
  }
  const commitMatch = /^\/commits\/([0-9a-f]{40})$/.exec(rest);
  if (commitMatch && method === 'GET') {
    if (!repo.store.has(commitMatch[1])) throw notFound();
    sendJson(res, 200, commitShape(repo, commitMatch[1]));
    return;
  }

  if (rest === '/git/refs' && method === 'POST') {
    const body = jsonBody(rawBody);
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/') || !repo.store.has(sha)) throw new HttpError(422, 'Invalid ref or sha');
    repo.refs.set(ref, sha);
    sendJson(res, 201, {
      ref,
      node_id: nodeId('Ref', nextObjectId++),
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${ref}`,
      object: { sha, type: repo.store.get(sha)?.type ?? 'commit', url: '' },
    });
    return;
  }
  const gitRefMatch = /^\/git\/refs\/(.+)$/.exec(rest);
  if (gitRefMatch && method === 'GET') {
    const ref = `refs/${decodeURIComponent(gitRefMatch[1])}`;
    const sha = repo.refs.get(ref);
    if (!sha) throw notFound();
    sendJson(res, 200, {
      ref,
      node_id: nodeId('Ref', nextObjectId++),
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${ref}`,
      object: { sha, type: repo.store.get(sha)?.type ?? 'commit', url: '' },
    });
    return;
  }
  if (gitRefMatch && method === 'DELETE') {
    const ref = `refs/${decodeURIComponent(gitRefMatch[1])}`;
    if (!repo.refs.delete(ref)) throw notFound();
    sendJson(res, 204, undefined);
    return;
  }

  const contentsMatch = /^\/contents(?:\/(.*))?$/.exec(rest);
  if (contentsMatch) {
    await handleContents(req, res, url, rawBody, repo, decodeURIComponent(contentsMatch[1] ?? ''));
    return;
  }

  if (rest === '/labels') {
    if (method === 'GET') {
      sendJson(res, 200, repo.labels.map(labelShape));
      return;
    }
    if (method === 'POST') {
      const body = jsonBody(rawBody);
      const name = str(body.name);
      if (!name) throw new HttpError(422, 'Label creation failed: name is required');
      if (repo.labels.some((label) => label.name.toLowerCase() === name.toLowerCase())) throw new HttpError(422, 'Label already exists');
      const label: Label = {
        id: nextObjectId++,
        name,
        color: (str(body.color) || 'ededed').replace(/^#/, ''),
        description: typeof body.description === 'string' ? body.description : null,
      };
      repo.labels.push(label);
      sendJson(res, 201, labelShape(label));
      return;
    }
    throw notFound();
  }

  if (rest === '/issues' || rest.startsWith('/issues')) {
    await handleIssues(req, res, url, rawBody, repo, rest);
    return;
  }

  if (rest === '/pulls' || rest.startsWith('/pulls')) {
    await handlePulls(req, res, url, rawBody, repo, rest);
    return;
  }

  throw notFound();
}

/** Commits reachable from a tip, newest first (generation order, stable). */
function orderCommits(repo: Repo, tip: string): string[] {
  const distances = commitDistances(repo.store, [tip]);
  return [...distances.entries()].sort((a, b) => a[1] - b[1]).map(([sha]) => sha);
}

function commitShape(repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.store.get(sha);
  if (!object || object.type !== 'commit') throw notFound('Commit not found');
  const commit = parseCommit(object.data);
  const person = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) return { name: line, email: '', date: nowIso() };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha,
    node_id: nodeId('Commit', nextObjectId++),
    commit: {
      author: person(commit.author),
      committer: person(commit.committer),
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree, url: '' },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
    author: null,
    committer: null,
    parents: commit.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
  };
}

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rawBody: Buffer,
  repo: Repo,
  filePath: string,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const refParam = url.searchParams.get('ref');
    let commitSha: string | null;
    if (refParam) {
      commitSha = branchTip(repo, refParam) ?? (repo.store.has(refParam) ? peelToCommit(repo.store, refParam) : null);
    } else {
      commitSha = branchTip(repo, repo.defaultBranch);
    }
    const files = filesAt(repo, commitSha);
    if (filePath === '' || filePath === '/') {
      sendJson(res, 200, dirListing(repo, files, ''));
      return;
    }
    const slot = files.get(filePath);
    if (slot) {
      const blob = repo.store.get(slot.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      sendJson(res, 200, {
        name: filePath.split('/').pop(),
        path: filePath,
        sha: slot.oid,
        size: data.length,
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        url: '',
        html_url: '',
        git_url: '',
        download_url: '',
        _links: { self: '', git: '', html: '' },
      });
      return;
    }
    const prefix = `${filePath}/`;
    if ([...files.keys()].some((path) => path.startsWith(prefix))) {
      sendJson(res, 200, dirListing(repo, files, prefix));
      return;
    }
    throw notFound();
  }

  if (method === 'PUT') {
    const body = jsonBody(rawBody);
    const branch = str(body.branch) || repo.defaultBranch;
    const tip = branchTip(repo, branch);
    const files = filesAt(repo, tip);
    const existing = files.get(filePath);
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (existing && givenSha !== undefined && givenSha !== existing.oid) {
      throw new HttpError(409, 'SHA does not match');
    }
    if (!existing && givenSha !== undefined) {
      throw new HttpError(422, 'SHA supplied for a file that does not exist');
    }
    if (typeof body.content !== 'string') throw new HttpError(422, 'Content is required');
    const data = Buffer.from(body.content.replace(/\s/g, ''), 'base64');
    const blobSha = repo.store.put('blob', data);
    files.set(filePath, { oid: blobSha, mode: '100644' });
    const message = str(body.message) || `Update ${filePath}`;
    const commitSha = commitFiles(repo, files, message, tip ? [tip] : []);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.updatedAt = nowIso();
    sendJson(res, existing ? 200 : 201, {
      content: {
        name: filePath.split('/').pop(),
        path: filePath,
        sha: blobSha,
        size: data.length,
        type: 'file',
        encoding: 'base64',
        url: '',
        html_url: '',
        git_url: '',
        download_url: '',
        _links: { self: '', git: '', html: '' },
      },
      commit: { sha: commitSha, message, url: '', author: null, committer: null, tree: { sha: '', url: '' }, parents: [] },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = jsonBody(rawBody);
    const branch = str(body.branch) || repo.defaultBranch;
    const tip = branchTip(repo, branch);
    const files = filesAt(repo, tip);
    const existing = files.get(filePath);
    if (!existing || !tip) throw notFound();
    if (typeof body.sha === 'string' && body.sha !== existing.oid) throw new HttpError(409, 'SHA does not match');
    files.delete(filePath);
    const message = str(body.message) || `Delete ${filePath}`;
    const commitSha = commitFiles(repo, files, message, [tip]);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.updatedAt = nowIso();
    sendJson(res, 200, { content: null, commit: { sha: commitSha, message, url: '' } });
    return;
  }

  throw notFound();
}

function dirListing(repo: Repo, files: Map<string, FileSlot>, prefix: string): Record<string, unknown>[] {
  const entries = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
  for (const [path, slot] of files) {
    if (!path.startsWith(prefix)) continue;
    const remainder = path.slice(prefix.length);
    const slash = remainder.indexOf('/');
    if (slash === -1) {
      const blob = repo.store.get(slot.oid);
      entries.set(remainder, { type: 'file', oid: slot.oid, size: blob?.data.length ?? 0 });
    } else {
      const dir = remainder.slice(0, slash);
      if (!entries.has(dir)) entries.set(dir, { type: 'dir', oid: ZERO_OID, size: 0 });
    }
  }
  return [...entries.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, entry]) => ({
      name,
      path: `${prefix}${name}`,
      sha: entry.oid,
      size: entry.size,
      type: entry.type,
      url: '',
      html_url: '',
      git_url: '',
      download_url: entry.type === 'file' ? '' : null,
      _links: { self: '', git: '', html: '' },
    }));
}

// ------------------------------------------------------------------ issues and pulls

function resolveLabels(repo: Repo, names: readonly string[]): Label[] {
  const resolved: Label[] = [];
  for (const name of names) {
    const label = repo.labels.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!label) throw new HttpError(422, `Label "${name}" does not exist`);
    resolved.push(label);
  }
  return resolved;
}

function findIssue(repo: Repo, number: number, wantPull: boolean): Issue | null {
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (!issue) return null;
  if (wantPull && !issue.pullRequest) return null;
  return issue;
}

async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rawBody: Buffer,
  repo: Repo,
  rest: string,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (rest === '/issues') {
    if (method === 'POST') {
      const body = jsonBody(rawBody);
      const title = str(body.title);
      if (!title) throw new HttpError(422, 'Issue creation failed: title is required');
      const labelNames = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
      const labels = resolveLabels(repo, labelNames);
      const issue: Issue = {
        id: nextObjectId++,
        number: repo.nextNumber++,
        title,
        body: str(body.body),
        state: 'open',
        labels,
        comments: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      repo.issues.push(issue);
      sendJson(res, 201, issueShape(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => !issue.pullRequest);
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list = [...list].sort((a, b) => (a.number - b.number) * (direction === 'asc' ? 1 : -1));
      if (sort !== 'created') list.reverse();
      const { page, perPage } = pagination(req, url);
      sendJson(res, 200, pageSlice(list, page, perPage).map((issue) => issueShape(repo, issue)), linkHeader(req, url, list.length, page, perPage));
      return;
    }
    throw notFound();
  }

  const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
  if (issueMatch) {
    const number = Number(issueMatch[1]);
    const issue = findIssue(repo, number, false);
    if (!issue) throw notFound('Issue not found');
    if (issueMatch[2]) {
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => commentShape(repo, comment)));
        return;
      }
      if (method === 'POST') {
        const body = jsonBody(rawBody);
        const comment: Comment = { id: nextObjectId++, body: str(body.body), createdAt: nowIso(), updatedAt: nowIso() };
        issue.comments.push(comment);
        issue.updatedAt = nowIso();
        sendJson(res, 201, commentShape(repo, comment));
        return;
      }
      throw notFound();
    }
    if (method === 'GET') {
      sendJson(res, 200, issueShape(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = jsonBody(rawBody);
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        issue.labels = resolveLabels(repo, body.labels.filter((x): x is string => typeof x === 'string'));
      }
      issue.updatedAt = nowIso();
      sendJson(res, 200, issueShape(repo, issue));
      return;
    }
    throw notFound();
  }

  throw notFound();
}

async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rawBody: Buffer,
  repo: Repo,
  rest: string,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (rest === '/pulls') {
    if (method === 'POST') {
      const body = jsonBody(rawBody);
      const title = str(body.title);
      const headRaw = str(body.head);
      const baseRaw = str(body.base) || repo.defaultBranch;
      const head = headRaw.includes(':') ? headRaw.split(':').pop() as string : headRaw;
      const base = baseRaw.includes(':') ? baseRaw.split(':').pop() as string : baseRaw;
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (!title || !headSha || !baseSha) throw new HttpError(422, 'Pull request creation failed: title, head and base are required');
      const issue: Issue = {
        id: nextObjectId++,
        number: repo.nextNumber++,
        title,
        body: str(body.body),
        state: 'open',
        labels: [],
        comments: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        pullRequest: { headRef: head, baseRef: base, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null },
      };
      repo.issues.push(issue);
      sendJson(res, 201, pullShape(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = repo.issues.filter((issue) => issue.pullRequest);
      if (state === 'open') list = list.filter((issue) => issue.state === 'open' && !issue.pullRequest?.merged);
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed' || issue.pullRequest?.merged);
      const { page, perPage } = pagination(req, url);
      sendJson(res, 200, pageSlice(list, page, perPage).map((issue) => pullShape(repo, issue)), linkHeader(req, url, list.length, page, perPage));
      return;
    }
    throw notFound();
  }

  const pullMatch = /^\/pulls\/(\d+)(\/files|\/merge)?$/.exec(rest);
  if (pullMatch) {
    const number = Number(pullMatch[1]);
    const issue = findIssue(repo, number, true);
    if (!issue) throw notFound('Pull request not found');
    const pull = issue.pullRequest as PullData;
    if (pullMatch[2] === '/files' && method === 'GET') {
      sendJson(res, 200, pullFiles(repo, issue).map((entry) => ({
        sha: entry.sha,
        filename: entry.filename,
        status: entry.status,
        additions: entry.additions,
        deletions: entry.deletions,
        changes: entry.changes,
        blob_url: '',
        raw_url: '',
        contents_url: '',
      })));
      return;
    }
    if (pullMatch[2] === '/merge' && method === 'PUT') {
      const body = jsonBody(rawBody);
      if (pull.merged || issue.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable');
      const mergeMethod = str(body.merge_method) || 'merge';
      const sha = performMerge(repo, issue, mergeMethod);
      if (!sha) throw new HttpError(405, 'Pull Request is not mergeable');
      sendJson(res, 200, {
        sha,
        merged: true,
        message: mergeMethod === 'squash' ? 'Pull Request successfully squashed and merged' : 'Pull Request successfully merged',
      });
      return;
    }
    if (method === 'GET' && !pullMatch[2]) {
      sendJson(res, 200, pullShape(repo, issue));
      return;
    }
    if (method === 'PATCH' && !pullMatch[2]) {
      const body = jsonBody(rawBody);
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      issue.updatedAt = nowIso();
      sendJson(res, 200, pullShape(repo, issue));
      return;
    }
    throw notFound();
  }

  throw notFound();
}

// ------------------------------------------------------------------ git smart HTTP

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

function sidebandPacket(band: number, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from([band]), data]);
  return pktLine(payload);
}

/** Split a sideband payload into framed packets of at most 65515 payload bytes each. */
function sidebandFrame(data: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    frames.push(sidebandPacket(1, data.subarray(offset, offset + CHUNK)));
  }
  if (frames.length === 0) frames.push(sidebandPacket(1, Buffer.alloc(0)));
  return frames;
}

interface PktReader {
  lines: string[];
  rest: Buffer;
}

/** Read pkt-lines from the front of a buffer; returns the text lines and the unparsed remainder. */
function readPktLines(buffer: Buffer, stopAtFlush = true): PktReader {
  const lines: string[] = [];
  let pos = 0;
  while (pos + 4 <= buffer.length) {
    const header = buffer.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      pos += 4;
      if (stopAtFlush) break;
      lines.push('\0flush');
      continue;
    }
    if (length === 1) {
      pos += 4;
      lines.push('\0delim');
      continue;
    }
    if (length === 2) {
      pos += 4;
      lines.push('\0response-end');
      continue;
    }
    if (length < 4 || pos + length > buffer.length) break;
    lines.push(buffer.toString('utf8', pos + 4, pos + length));
    pos += length;
  }
  return { lines, rest: buffer.subarray(pos) };
}

function stripLf(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

/** Sorted ref advertisement entries (HEAD first) for a repository. */
function advertisedRefs(repo: Repo): { name: string; oid: string }[] {
  const refs: { name: string; oid: string }[] = [];
  const head = repo.refs.get(headRef(repo));
  refs.push({ name: 'HEAD', oid: head ?? ZERO_OID });
  for (const name of [...repo.refs.keys()].sort()) refs.push({ name, oid: repo.refs.get(name) as string });
  return refs;
}

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=makefun-forge/1.0';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=makefun-forge/1.0';

function infoRefs(repo: Repo, service: string, v2: boolean): Buffer {
  const preamble = pktLine(`# service=${service}\n`);
  if (service === 'git-upload-pack' && v2) {
    const lines = [
      'version 2',
      'agent=makefun-forge/1.0',
      'ls-refs=unborn peel symrefs ref-prefix',
      'fetch=shallow wait-for-done',
      'object-format=sha1',
    ];
    return Buffer.concat([preamble, FLUSH, ...lines.map((line) => pktLine(`${line}\n`)), FLUSH]);
  }
  const refs = advertisedRefs(repo);
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const parts: Buffer[] = [preamble, FLUSH];
  if (refs.length === 1 && refs[0].oid === ZERO_OID && repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

interface FetchRequest {
  wants: string[];
  wantRefs: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

function parseFetchLines(lines: string[]): FetchRequest {
  const parsed: FetchRequest = { wants: [], wantRefs: [], haves: [], shallow: [], deepen: null, done: false };
  for (const rawLine of lines) {
    const line = stripLf(rawLine);
    if (line.startsWith('want ')) parsed.wants.push(line.slice(5).trim());
    else if (line.startsWith('want-ref ')) parsed.wantRefs.push(line.slice(9).trim());
    else if (line.startsWith('have ')) parsed.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) parsed.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) parsed.deepen = Number(line.slice(7).trim()) || null;
    else if (line === 'done') parsed.done = true;
  }
  return parsed;
}

/**
 * Choose the objects a fetch sends: the closure of the wants (bounded by depth when asked), minus
 * what the client already holds. A shallow client's boundary commits count as held with their
 * trees and blobs, but their parents are not traversed.
 */
function planFetch(repo: Repo, request: FetchRequest): { objects: Set<string>; shallow: string[]; unshallow: string[] } {
  const store = repo.store;
  const wants = [...request.wants];
  for (const ref of request.wantRefs) {
    const oid = repo.refs.get(ref);
    if (oid) wants.push(oid);
  }
  const held = new Set<string>();
  {
    const shallowSet = new Set(request.shallow);
    const stack: string[] = [];
    for (const have of request.haves) if (store.has(have)) stack.push(have);
    const seenCommits = new Set<string>();
    while (stack.length) {
      const oid = stack.pop() as string;
      const object = store.get(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        if (seenCommits.has(oid)) continue;
        seenCommits.add(oid);
        held.add(oid);
        const commit = parseCommit(object.data);
        for (const entry of reachableObjects(store, [commit.tree])) held.add(entry);
        if (!shallowSet.has(oid)) stack.push(...commit.parents);
      } else if (object.type === 'tag') {
        held.add(oid);
        const target = peelToCommit(store, oid);
        if (target) stack.push(target);
      } else {
        held.add(oid);
      }
    }
  }

  let included: Set<string>;
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (request.deepen !== null && request.deepen > 0) {
    const distances = commitDistances(store, wants);
    const includedCommits = new Set<string>();
    for (const [oid, distance] of distances) {
      if (distance <= request.deepen) includedCommits.add(oid);
    }
    included = new Set<string>();
    for (const oid of includedCommits) {
      included.add(oid);
      const commit = parseCommit((store.get(oid) as { data: Buffer }).data);
      for (const entry of reachableObjects(store, [commit.tree])) included.add(entry);
      if (distances.get(oid) === request.deepen && commit.parents.length > 0) shallowOut.push(oid);
    }
    for (const tagTip of wants) {
      const object = store.get(tagTip);
      if (object && object.type === 'tag') included.add(tagTip);
    }
    for (const clientShallow of request.shallow) {
      if (includedCommits.has(clientShallow) && !shallowOut.includes(clientShallow)) unshallowOut.push(clientShallow);
    }
  } else {
    included = reachableObjects(store, wants);
  }

  const objects = new Set<string>();
  for (const oid of included) if (!held.has(oid)) objects.add(oid);
  return { objects, shallow: shallowOut, unshallow: unshallowOut };
}

async function handleUploadPackV0(req: IncomingMessage, res: ServerResponse, repo: Repo, rawBody: Buffer): Promise<void> {
  const { lines, rest } = readPktLines(rawBody);
  void rest;
  // The request is two pkt-line blocks: wants/shallow, flush, haves, "done". readPktLines stops at
  // the first flush, so parse the remainder too.
  const all: string[] = [...lines];
  let tail = rest;
  while (tail.length >= 4) {
    const parsed = readPktLines(tail);
    if (parsed.lines.length === 0 && parsed.rest.length === tail.length) break;
    all.push(...parsed.lines);
    tail = parsed.rest;
    if (parsed.lines.length === 0) break;
  }
  const request = parseFetchLines(all);
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const acked = request.haves.find((have) => repo.store.has(have));
  parts.push(pktLine(acked ? `ACK ${acked}\n` : 'NAK\n'));
  const pack = buildPack(repo.store, plan.objects);
  for (const frame of sidebandFrame(pack)) parts.push(frame);
  parts.push(FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

async function handleFetchV2(res: ServerResponse, repo: Repo, rawBody: Buffer): Promise<void> {
  const { lines } = readPktLines(rawBody, false);
  const commandIndex = lines.findIndex((line) => stripLf(line).startsWith('command='));
  const argLines = commandIndex === -1 ? lines : lines.slice(commandIndex + 1);
  const request = parseFetchLines(argLines.filter((line) => !line.startsWith('\0')));
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (!request.done) {
    const acked = request.haves.filter((have) => repo.store.has(have));
    if (acked.length === 0) {
      // No common ground yet: a bare NAK, and the client sends more haves (or done).
      parts.push(pktLine('acknowledgments\n'));
      parts.push(pktLine('NAK\n'));
      parts.push(FLUSH);
      sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    // Common ground found: "ready" in the acknowledgments, and the packfile follows in the
    // same response (that is what ready means in protocol v2).
    parts.push(pktLine('acknowledgments\n'));
    for (const oid of acked) parts.push(pktLine(`ACK ${oid}\n`));
    parts.push(pktLine('ready\n'));
    parts.push(DELIM);
  }
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  if (request.wantRefs.length) {
    parts.push(pktLine('wanted-refs\n'));
    for (const ref of request.wantRefs) {
      const oid = repo.refs.get(ref);
      if (oid) parts.push(pktLine(`${oid} ${ref}\n`));
    }
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  const pack = buildPack(repo.store, plan.objects);
  for (const frame of sidebandFrame(pack)) parts.push(frame);
  parts.push(FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleLsRefs(res: ServerResponse, repo: Repo, rawBody: Buffer): void {
  const { lines } = readPktLines(rawBody, false);
  const args = lines.map(stripLf).filter((line) => !line.startsWith('\0'));
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const line of args) {
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const headOid = repo.refs.get(headRef(repo));
  if (matches('HEAD')) {
    if (headOid) {
      out.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headRef(repo)}` : ''}\n`));
    } else if (unborn) {
      out.push(pktLine(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${headRef(repo)}` : ''} unborn\n`));
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let suffix = '';
    if (peel) {
      const object = repo.store.get(oid);
      if (object && object.type === 'tag') {
        const target = peelToCommit(repo.store, oid);
        if (target) suffix = ` peeled:${target}`;
      }
    }
    out.push(pktLine(`${oid} ${name}${suffix}\n`));
  }
  out.push(FLUSH);
  sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
}

async function handleGitPost(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string, rawBody: Buffer): Promise<void> {
  if (service === 'git-upload-pack') {
    const protocol = req.headers['git-protocol'] ?? '';
    const firstLine = stripLf(readPktLines(rawBody, false).lines[0] ?? '');
    if (firstLine.startsWith('command=ls-refs')) {
      handleLsRefs(res, repo, rawBody);
      return;
    }
    if (firstLine.startsWith('command=fetch')) {
      await handleFetchV2(res, repo, rawBody);
      return;
    }
    if (String(protocol).includes('version=2')) {
      // A v2 request we do not recognise: answer with an empty packfile section rather than hang.
      await handleFetchV2(res, repo, rawBody);
      return;
    }
    await handleUploadPackV0(req, res, repo, rawBody);
    return;
  }
  await handleReceivePack(res, repo, rawBody);
}

async function handleReceivePack(res: ServerResponse, repo: Repo, rawBody: Buffer): Promise<void> {
  const { lines, rest } = readPktLines(rawBody);
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const rawLine of lines) {
    let line = stripLf(rawLine);
    const nul = line.indexOf('\0');
    if (nul !== -1) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0]) && /^[0-9a-f]{40}$/.test(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  }

  let unpackOk = true;
  let unpackDetail = '';
  if (rest.length > 0) {
    try {
      await unpackInto(repo.store, rest);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const report: string[] = [];
  report.push(unpackOk ? 'unpack ok' : `unpack ${unpackDetail || 'error'}`);
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.newOid === ZERO_OID) {
        if (current === ZERO_OID) {
          report.push(`ng ${command.ref} reference does not exist`);
        } else if (current !== command.oldOid) {
          report.push(`ng ${command.ref} stale info`);
        } else {
          repo.refs.delete(command.ref);
          report.push(`ok ${command.ref}`);
        }
        continue;
      }
      if (!repo.store.has(command.newOid)) {
        report.push(`ng ${command.ref} unknown object`);
        continue;
      }
      if (current !== command.oldOid) {
        report.push(`ng ${command.ref} stale info`);
        continue;
      }
      if (current !== ZERO_OID) {
        const newCommit = peelToCommit(repo.store, command.newOid);
        const oldCommit = peelToCommit(repo.store, current);
        if (newCommit && oldCommit && !isAncestor(repo.store, oldCommit, newCommit)) {
          report.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
      }
      repo.refs.set(command.ref, command.newOid);
      if (command.ref.startsWith('refs/heads/')) {
        const branch = command.ref.slice('refs/heads/'.length);
        if (!repo.refs.has(headRef(repo)) && branch === repo.defaultBranch) {
          // default branch tip created; nothing extra to do
        }
      }
      report.push(`ok ${command.ref}`);
    }
    repo.updatedAt = nowIso();
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpacker error`);
  }

  // The report is a pkt-line stream carried inside sideband band 1, and it carries its own
  // terminating flush inside the band; a second flush ends the response itself.
  const reportBody = Buffer.concat([...report.map((line) => pktLine(`${line}\n`)), FLUSH]);
  const framed = sidebandFrame(reportBody);
  sendRaw(res, 200, Buffer.concat([...framed, FLUSH]), 'application/x-git-receive-pack-result');
}

// ------------------------------------------------------------------ GraphQL v4

type GqlValue =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

interface GqlField {
  name: string;
  alias: string | null;
  args: Map<string, GqlValue>;
  selection: GqlField[] | null;
  fragmentSpread: string | null;
  inlineFragmentType: string | null;
}

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: GqlField[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string; selection: GqlField[] }>;
}

function tokenizeGql(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end === -1 ? source.length : end)}"`);
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          value += source[j + 1];
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push(`"${value}"`);
      i = j + 1;
      continue;
    }
    if ('{}()[]:$=@!'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*|^-?\d+(\.\d+)?/.exec(source.slice(i));
    if (match) {
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`GraphQL parse: expected ${token}, got ${got}`);
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: GqlField[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek() && /^[A-Za-z_]/.test(this.peek() as string) && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.parseVariableDefinitions();
        operations.push({ type, name, selection: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0 && this.pos < this.tokens.length) {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): GqlField {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        return { name: '', alias: null, args: new Map(), selection: this.parseSelectionSet(), fragmentSpread: null, inlineFragmentType: typeCondition };
      }
      const spread = this.next();
      return { name: '', alias: null, args: new Map(), selection: null, fragmentSpread: spread, inlineFragmentType: null };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = new Map<string, GqlValue>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.pos < this.tokens.length) {
        const argName = this.next();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    if (this.peek() === '@') {
      // Skip a directive and its arguments.
      this.next();
      this.next();
      if (this.peek() === '(') this.parseVariableDefinitions();
    }
    let selection: GqlField[] | null = null;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { name, alias, args, selection, fragmentSpread: null, inlineFragmentType: null };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']' && this.pos < this.tokens.length) items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, GqlValue>();
      while (this.peek() !== '}' && this.pos < this.tokens.length) {
        const key = this.next();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'variable':
      return variables[value.name] ?? null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = resolveValue(inner, variables);
      return out;
    }
  }
}

function argValue(field: GqlField, name: string, variables: Record<string, unknown>): unknown {
  const value = field.args.get(name);
  return value ? resolveValue(value, variables) : undefined;
}

// The GraphQL type system this forge serves: enough of GitHub's v4 for the suite's documents.
interface GqlTypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE' | 'SCALAR';
  fields?: Record<string, string>;
  enumValues?: string[];
}

const GQL_TYPES: Record<string, GqlTypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: { viewer: 'User', repository: 'Repository', node: 'Node', rateLimit: 'RateLimit', search: 'SearchResultItemConnection', __type: '__Type', __schema: '__Schema' },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: 'CreateIssuePayload',
      closeIssue: 'CloseIssuePayload',
      createPullRequest: 'CreatePullRequestPayload',
      mergePullRequest: 'MergePullRequestPayload',
      addComment: 'AddCommentPayload',
    },
  },
  User: { kind: 'OBJECT', fields: { login: 'String', id: 'ID', name: 'String', email: 'String', url: 'URI' } },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: 'ID',
      databaseId: 'Int',
      name: 'String',
      nameWithOwner: 'String',
      description: 'String',
      isPrivate: 'Boolean',
      owner: 'User',
      defaultBranchRef: 'Ref',
      viewerPermission: 'RepositoryPermission',
      hasIssuesEnabled: 'Boolean',
      issue: 'Issue',
      issues: 'IssueConnection',
      pullRequest: 'PullRequest',
      pullRequests: 'PullRequestConnection',
      createdAt: 'DateTime',
      updatedAt: 'DateTime',
      url: 'URI',
    },
  },
  Ref: { kind: 'OBJECT', fields: { name: 'String', prefix: 'String', target: 'GitObject' } },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: 'ID',
      databaseId: 'Int',
      number: 'Int',
      title: 'String',
      body: 'String',
      state: 'IssueState',
      author: 'User',
      createdAt: 'DateTime',
      updatedAt: 'DateTime',
      closedAt: 'DateTime',
      url: 'URI',
      comments: 'IssueCommentConnection',
      labels: 'LabelConnection',
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: 'ID',
      databaseId: 'Int',
      number: 'Int',
      title: 'String',
      body: 'String',
      state: 'PullRequestState',
      merged: 'Boolean',
      mergedAt: 'DateTime',
      headRefName: 'String',
      baseRefName: 'String',
      mergeable: 'MergeableState',
      mergeCommit: 'Commit',
      files: 'PullRequestChangedFileConnection',
      author: 'User',
      createdAt: 'DateTime',
      updatedAt: 'DateTime',
      url: 'URI',
    },
  },
  IssueConnection: { kind: 'OBJECT', fields: { nodes: 'Issue', totalCount: 'Int', pageInfo: 'PageInfo' } },
  PullRequestConnection: { kind: 'OBJECT', fields: { nodes: 'PullRequest', totalCount: 'Int', pageInfo: 'PageInfo' } },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: { nodes: 'PullRequestChangedFile', totalCount: 'Int', pageInfo: 'PageInfo' } },
  PullRequestChangedFile: { kind: 'OBJECT', fields: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' } },
  IssueCommentConnection: { kind: 'OBJECT', fields: { nodes: 'IssueComment', totalCount: 'Int', pageInfo: 'PageInfo' } },
  IssueComment: { kind: 'OBJECT', fields: { id: 'ID', body: 'String', author: 'User', createdAt: 'DateTime' } },
  LabelConnection: { kind: 'OBJECT', fields: { nodes: 'Label', totalCount: 'Int' } },
  Label: { kind: 'OBJECT', fields: { id: 'ID', name: 'String', color: 'String', description: 'String' } },
  PageInfo: { kind: 'OBJECT', fields: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' } },
  RateLimit: { kind: 'OBJECT', fields: { limit: 'Int', cost: 'Int', remaining: 'Int', resetAt: 'DateTime', nodeCount: 'Int', used: 'Int' } },
  Commit: { kind: 'OBJECT', fields: { id: 'ID', oid: 'String', message: 'String', committedDate: 'DateTime' } },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: 'Issue', clientMutationId: 'String' } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: 'Issue', clientMutationId: 'String' } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: 'PullRequest', clientMutationId: 'String' } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: 'PullRequest', clientMutationId: 'String' } },
  AddCommentPayload: { kind: 'OBJECT', fields: { commentEdge: 'IssueCommentEdge', clientMutationId: 'String' } },
  IssueCommentEdge: { kind: 'OBJECT', fields: { node: 'IssueComment', cursor: 'String' } },
  Node: { kind: 'INTERFACE', fields: { id: 'ID' } },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  __Type: { kind: 'OBJECT', fields: { name: 'String', kind: 'String', description: 'String', fields: '__Field', enumValues: '__EnumValue' } },
  __Field: { kind: 'OBJECT', fields: { name: 'String', description: 'String', type: '__Type', isDeprecated: 'Boolean', deprecationReason: 'String' } },
  __EnumValue: { kind: 'OBJECT', fields: { name: 'String', description: 'String', isDeprecated: 'Boolean', deprecationReason: 'String' } },
  __Schema: { kind: 'OBJECT', fields: { queryType: '__Type', mutationType: '__Type' } },
};

interface GqlContext {
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selection: GqlField[] }>;
  errors: { message: string }[];
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || !cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /cursor:(\d+)/.exec(decoded);
    return match ? Number(match[1]) + 1 : 0;
  } catch {
    return 0;
  }
}

function connection<T>(items: readonly T[], field: GqlField, ctx: GqlContext): { nodes: T[]; pageInfo: Record<string, unknown>; totalCount: number } {
  const first = argValue(field, 'first', ctx.variables);
  const after = argValue(field, 'after', ctx.variables);
  const start = indexFromCursor(after);
  const limit = typeof first === 'number' ? first : items.length;
  const slice = items.slice(start, start + limit);
  const hasNext = start + slice.length < items.length;
  return {
    nodes: slice,
    totalCount: items.length,
    pageInfo: {
      hasNextPage: hasNext,
      hasPreviousPage: start > 0,
      startCursor: slice.length ? cursorFor(start) : null,
      endCursor: slice.length ? cursorFor(start + slice.length - 1) : null,
    },
  };
}

type GqlSource =
  | { gqlType: 'User' }
  | { gqlType: 'Repository'; repo: Repo }
  | { gqlType: 'Issue'; repo: Repo; issue: Issue }
  | { gqlType: 'PullRequest'; repo: Repo; issue: Issue }
  | { gqlType: 'IssueComment'; repo: Repo; comment: Comment }
  | { gqlType: 'Raw'; typeName: string; value: Record<string, unknown> };

function executeSelection(source: GqlSource | null, typeName: string, selection: GqlField[], ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.fragmentSpread) {
      const fragment = ctx.fragments.get(field.fragmentSpread);
      if (fragment && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        Object.assign(out, executeSelection(source, typeName, fragment.selection, ctx));
      }
      continue;
    }
    if (field.inlineFragmentType) {
      if (field.inlineFragmentType === typeName || field.inlineFragmentType === 'Node') {
        Object.assign(out, executeSelection(source, typeName, field.selection ?? [], ctx));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    out[key] = executeField(source, typeName, field, ctx);
  }
  return out;
}

function executeField(source: GqlSource | null, typeName: string, field: GqlField, ctx: GqlContext): unknown {
  const typeDef = GQL_TYPES[typeName];
  if (field.name === '__typename') return typeName;
  if (typeName === 'Query' && field.name === '__type') {
    const name = String(argValue(field, 'name', ctx.variables) ?? '');
    return typeValue(name, field, ctx);
  }
  if (typeName === 'Query' && field.name === '__schema') {
    return executeSelection({ gqlType: 'Raw', typeName: '__Schema', value: {} }, '__Schema', field.selection ?? [], ctx);
  }
  if (!typeDef || !typeDef.fields || !(field.name in typeDef.fields)) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
    return null;
  }
  const raw = resolveRawField(source, typeName, field, ctx);
  return completeValue(raw, typeDef.fields[field.name], field, ctx);
}

function typeValue(name: string, field: GqlField, ctx: GqlContext): unknown {
  const def = GQL_TYPES[name];
  if (!def) return null;
  const raw: Record<string, unknown> = {
    name,
    kind: def.kind,
    description: null,
    fields: def.fields
      ? Object.entries(def.fields).map(([fieldName, fieldType]) => ({
          name: fieldName,
          description: null,
          isDeprecated: false,
          deprecationReason: null,
          __fieldType: fieldType,
        }))
      : null,
    enumValues: def.enumValues ? def.enumValues.map((value) => ({ name: value, description: null, isDeprecated: false, deprecationReason: null })) : null,
  };
  return completeRaw(raw, '__Type', field, ctx);
}

function completeRaw(raw: Record<string, unknown>, typeName: string, field: GqlField, ctx: GqlContext): unknown {
  if (!field.selection) return raw;
  const out: Record<string, unknown> = {};
  for (const sub of field.selection) {
    if (sub.fragmentSpread || sub.inlineFragmentType) {
      Object.assign(out, completeRaw(raw, typeName, { ...sub, selection: sub.selection }, ctx));
      continue;
    }
    const key = sub.alias ?? sub.name;
    if (sub.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (typeName === '__Type' && sub.name === 'fields') {
      const fields = raw.fields as { name: string; __fieldType: string }[] | null;
      out[key] = fields
        ? fields.map((entry) => completeRaw({ name: entry.name, description: null, isDeprecated: false, deprecationReason: null, __typeName: entry.__fieldType }, '__Field', sub, ctx))
        : null;
      continue;
    }
    if (typeName === '__Field' && sub.name === 'type') {
      out[key] = typeValue(String(raw.__typeName ?? 'String'), sub, ctx);
      continue;
    }
    if (typeName === '__Schema' && (sub.name === 'queryType' || sub.name === 'mutationType')) {
      out[key] = typeValue(sub.name === 'queryType' ? 'Query' : 'Mutation', sub, ctx);
      continue;
    }
    out[key] = completeValue(raw[sub.name] ?? null, GQL_TYPES[typeName]?.fields?.[sub.name] ?? 'String', sub, ctx);
  }
  return out;
}

function completeValue(raw: unknown, typeName: string, field: GqlField, ctx: GqlContext): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((item) => completeValue(item, typeName, field, ctx));
  if (typeof raw === 'object' && raw !== null && 'gqlType' in (raw as Record<string, unknown>)) {
    const source = raw as GqlSource;
    const sourceType = source.gqlType === 'Raw' ? (source as { typeName: string }).typeName : source.gqlType;
    return executeSelection(source, sourceType, field.selection ?? [], ctx);
  }
  if (typeof raw === 'object' && field.selection) {
    return completeRaw(raw as Record<string, unknown>, typeName, field, ctx);
  }
  return raw;
}

function decodeNodeId(id: unknown): { type: string; numericId: number } | null {
  if (typeof id !== 'string') return null;
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(decoded);
    if (!match) return null;
    return { type: match[1], numericId: Number(match[2]) };
  } catch {
    return null;
  }
}

function findRepoById(id: number): Repo | null {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return null;
}

function findIssueById(id: number): { repo: Repo; issue: Issue } | null {
  for (const repo of repos.values()) {
    const issue = repo.issues.find((candidate) => candidate.id === id);
    if (issue) return { repo, issue };
  }
  return null;
}

function resolveRawField(source: GqlSource | null, typeName: string, field: GqlField, ctx: GqlContext): unknown {
  if (typeName === 'Query') {
    switch (field.name) {
      case 'viewer':
        return { gqlType: 'User' };
      case 'repository': {
        const owner = String(argValue(field, 'owner', ctx.variables) ?? '');
        const name = String(argValue(field, 'name', ctx.variables) ?? '');
        const repo = findRepo(owner, name);
        return repo ? { gqlType: 'Repository', repo } : null;
      }
      case 'node': {
        const decoded = decodeNodeId(argValue(field, 'id', ctx.variables));
        if (!decoded) return null;
        if (decoded.type === 'Repository') {
          const repo = findRepoById(decoded.numericId);
          return repo ? { gqlType: 'Repository', repo } : null;
        }
        if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
          const found = findIssueById(decoded.numericId);
          if (!found) return null;
          return found.issue.pullRequest
            ? { gqlType: 'PullRequest', repo: found.repo, issue: found.issue }
            : { gqlType: 'Issue', repo: found.repo, issue: found.issue };
        }
        if (decoded.type === 'User') return { gqlType: 'User' };
        return null;
      }
      case 'rateLimit':
        return {
          gqlType: 'Raw',
          typeName: 'RateLimit',
          value: { limit: 5000, cost: 1, remaining: 4999, resetAt: '2030-01-01T00:00:00Z', nodeCount: 0, used: 1 },
        };
    }
  }

  if (typeName === 'Mutation') {
    const input = (argValue(field, 'input', ctx.variables) ?? {}) as Record<string, unknown>;
    switch (field.name) {
      case 'createIssue': {
        const decoded = decodeNodeId(input.repositoryId);
        const repo = decoded ? findRepoById(decoded.numericId) : null;
        if (!repo) {
          ctx.errors.push({ message: 'Repository not found' });
          return null;
        }
        const issue: Issue = {
          id: nextObjectId++,
          number: repo.nextNumber++,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          state: 'open',
          labels: [],
          comments: [],
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        repo.issues.push(issue);
        return { gqlType: 'Raw', typeName: 'CreateIssuePayload', value: { issue: { gqlType: 'Issue', repo, issue }, clientMutationId: (input.clientMutationId as string) ?? null } };
      }
      case 'closeIssue': {
        const decoded = decodeNodeId(input.issueId);
        const found = decoded ? findIssueById(decoded.numericId) : null;
        if (!found) {
          ctx.errors.push({ message: 'Issue not found' });
          return null;
        }
        found.issue.state = 'closed';
        found.issue.updatedAt = nowIso();
        return { gqlType: 'Raw', typeName: 'CloseIssuePayload', value: { issue: { gqlType: 'Issue', repo: found.repo, issue: found.issue }, clientMutationId: (input.clientMutationId as string) ?? null } };
      }
      case 'createPullRequest': {
        const decoded = decodeNodeId(input.repositoryId);
        const repo = decoded ? findRepoById(decoded.numericId) : null;
        if (!repo) {
          ctx.errors.push({ message: 'Repository not found' });
          return null;
        }
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        const headSha = branchTip(repo, headRef);
        const baseSha = branchTip(repo, baseRef);
        if (!headSha || !baseSha) {
          ctx.errors.push({ message: 'Head or base branch not found' });
          return null;
        }
        const issue: Issue = {
          id: nextObjectId++,
          number: repo.nextNumber++,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          state: 'open',
          labels: [],
          comments: [],
          createdAt: nowIso(),
          updatedAt: nowIso(),
          pullRequest: { headRef, baseRef, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null },
        };
        repo.issues.push(issue);
        return { gqlType: 'Raw', typeName: 'CreatePullRequestPayload', value: { pullRequest: { gqlType: 'PullRequest', repo, issue }, clientMutationId: (input.clientMutationId as string) ?? null } };
      }
      case 'mergePullRequest': {
        const decoded = decodeNodeId(input.pullRequestId);
        const found = decoded ? findIssueById(decoded.numericId) : null;
        if (!found || !found.issue.pullRequest) {
          ctx.errors.push({ message: 'Pull request not found' });
          return null;
        }
        const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
        const sha = performMerge(found.repo, found.issue, method);
        if (!sha) {
          ctx.errors.push({ message: 'Pull request is not mergeable' });
          return { gqlType: 'Raw', typeName: 'MergePullRequestPayload', value: { pullRequest: { gqlType: 'PullRequest', repo: found.repo, issue: found.issue }, clientMutationId: (input.clientMutationId as string) ?? null } };
        }
        return { gqlType: 'Raw', typeName: 'MergePullRequestPayload', value: { pullRequest: { gqlType: 'PullRequest', repo: found.repo, issue: found.issue }, clientMutationId: (input.clientMutationId as string) ?? null } };
      }
      case 'addComment': {
        const decoded = decodeNodeId(input.subjectId);
        const found = decoded ? findIssueById(decoded.numericId) : null;
        if (!found) {
          ctx.errors.push({ message: 'Subject not found' });
          return null;
        }
        const comment: Comment = { id: nextObjectId++, body: String(input.body ?? ''), createdAt: nowIso(), updatedAt: nowIso() };
        found.issue.comments.push(comment);
        return {
          gqlType: 'Raw',
          typeName: 'AddCommentPayload',
          value: {
            commentEdge: { gqlType: 'Raw', typeName: 'IssueCommentEdge', value: { node: { gqlType: 'IssueComment', repo: found.repo, comment }, cursor: cursorFor(found.issue.comments.length - 1) } },
            clientMutationId: (input.clientMutationId as string) ?? null,
          },
        };
      }
    }
    return null;
  }

  if (!source) return null;

  if (source.gqlType === 'Raw') {
    return (source.value as Record<string, unknown>)[field.name] ?? null;
  }
  if (source.gqlType === 'User') {
    switch (field.name) {
      case 'login': return VIEWER.login;
      case 'id': return nodeId('User', VIEWER.id);
      case 'name': return VIEWER.name;
      case 'email': return VIEWER.email;
      case 'url': return `https://forge.invalid/${VIEWER.login}`;
    }
    return null;
  }
  if (source.gqlType === 'Repository') {
    const repo = source.repo;
    switch (field.name) {
      case 'id': return nodeId('Repository', repo.id);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'description': return repo.description;
      case 'isPrivate': return repo.isPrivate;
      case 'owner': return { gqlType: 'User' };
      case 'defaultBranchRef': {
        const tip = branchTip(repo, repo.defaultBranch);
        return { gqlType: 'Raw', typeName: 'Ref', value: { name: repo.defaultBranch, prefix: 'refs/heads/', target: tip ? { gqlType: 'Raw', typeName: 'Commit', value: { id: nodeId('Commit', 0), oid: tip, message: '', committedDate: repo.updatedAt } } : null } };
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'createdAt': return repo.createdAt;
      case 'updatedAt': return repo.updatedAt;
      case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}`;
      case 'issue': {
        const number = Number(argValue(field, 'number', ctx.variables));
        const issue = repo.issues.find((candidate) => candidate.number === number && !candidate.pullRequest);
        return issue ? { gqlType: 'Issue', repo, issue } : null;
      }
      case 'issues': {
        const states = argValue(field, 'states', ctx.variables) as string[] | undefined;
        const orderBy = argValue(field, 'orderBy', ctx.variables) as { field?: string; direction?: string } | undefined;
        let list = repo.issues.filter((issue) => !issue.pullRequest);
        if (Array.isArray(states) && states.length) {
          list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
        }
        const direction = orderBy?.direction === 'ASC' ? 1 : -1;
        list = [...list].sort((a, b) => (a.number - b.number) * direction);
        const conn = connection(list, field, ctx);
        return {
          gqlType: 'Raw',
          typeName: 'IssueConnection',
          value: {
            nodes: conn.nodes.map((issue) => ({ gqlType: 'Issue', repo, issue })),
            pageInfo: { gqlType: 'Raw', typeName: 'PageInfo', value: conn.pageInfo },
            totalCount: conn.totalCount,
          },
        };
      }
      case 'pullRequest': {
        const number = Number(argValue(field, 'number', ctx.variables));
        const issue = repo.issues.find((candidate) => candidate.number === number && candidate.pullRequest);
        return issue ? { gqlType: 'PullRequest', repo, issue } : null;
      }
      case 'pullRequests': {
        const states = argValue(field, 'states', ctx.variables) as string[] | undefined;
        let list = repo.issues.filter((issue) => issue.pullRequest);
        if (Array.isArray(states) && states.length) {
          list = list.filter((issue) => {
            const state = issue.pullRequest?.merged ? 'MERGED' : issue.state.toUpperCase();
            return states.includes(state);
          });
        }
        const conn = connection(list, field, ctx);
        return {
          gqlType: 'Raw',
          typeName: 'PullRequestConnection',
          value: {
            nodes: conn.nodes.map((issue) => ({ gqlType: 'PullRequest', repo, issue })),
            pageInfo: { gqlType: 'Raw', typeName: 'PageInfo', value: conn.pageInfo },
            totalCount: conn.totalCount,
          },
        };
      }
    }
    return null;
  }
  if (source.gqlType === 'Issue' || source.gqlType === 'PullRequest') {
    const { repo, issue } = source;
    const pull = issue.pullRequest;
    switch (field.name) {
      case 'id': return nodeId(source.gqlType, issue.id);
      case 'databaseId': return issue.id;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state':
        if (source.gqlType === 'PullRequest') return pull?.merged ? 'MERGED' : issue.state.toUpperCase();
        return issue.state.toUpperCase();
      case 'author': return { gqlType: 'User' };
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'closedAt': return issue.state === 'closed' ? issue.updatedAt : null;
      case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}/${source.gqlType === 'PullRequest' ? 'pull' : 'issues'}/${issue.number}`;
      case 'merged': return pull?.merged ?? false;
      case 'mergedAt': return pull?.mergedAt ?? null;
      case 'headRefName': return pull?.headRef ?? '';
      case 'baseRefName': return pull?.baseRef ?? '';
      case 'mergeable': {
        const mergeable = computeMergeable(repo, issue);
        return mergeable === null ? 'UNKNOWN' : mergeable ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'mergeCommit': {
        if (!pull?.mergeCommitSha) return null;
        return { gqlType: 'Raw', typeName: 'Commit', value: { id: nodeId('Commit', 0), oid: pull.mergeCommitSha, message: '', committedDate: pull.mergedAt } };
      }
      case 'files': {
        const files = pullFiles(repo, issue).map((entry) => ({
          gqlType: 'Raw',
          typeName: 'PullRequestChangedFile',
          value: { path: entry.filename, additions: entry.additions, deletions: entry.deletions, changeType: entry.status.toUpperCase() },
        }));
        const conn = connection(files, field, ctx);
        return {
          gqlType: 'Raw',
          typeName: 'PullRequestChangedFileConnection',
          value: { nodes: conn.nodes, pageInfo: { gqlType: 'Raw', typeName: 'PageInfo', value: conn.pageInfo }, totalCount: conn.totalCount },
        };
      }
      case 'comments': {
        const conn = connection(issue.comments, field, ctx);
        return {
          gqlType: 'Raw',
          typeName: 'IssueCommentConnection',
          value: {
            nodes: conn.nodes.map((comment) => ({ gqlType: 'IssueComment', repo, comment })),
            pageInfo: { gqlType: 'Raw', typeName: 'PageInfo', value: conn.pageInfo },
            totalCount: conn.totalCount,
          },
        };
      }
      case 'labels': {
        return {
          gqlType: 'Raw',
          typeName: 'LabelConnection',
          value: {
            nodes: issue.labels.map((label) => ({ gqlType: 'Raw', typeName: 'Label', value: { id: nodeId('Label', label.id), name: label.name, color: label.color, description: label.description } })),
            totalCount: issue.labels.length,
          },
        };
      }
    }
    return null;
  }
  if (source.gqlType === 'IssueComment') {
    switch (field.name) {
      case 'id': return nodeId('IssueComment', source.comment.id);
      case 'body': return source.comment.body;
      case 'author': return { gqlType: 'User' };
      case 'createdAt': return source.comment.createdAt;
    }
    return null;
  }
  return null;
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  if (!authorized(req)) {
    if (!hasAuthHeader(req)) throw new HttpError(401, 'Requires authentication');
    throw new HttpError(401, 'Bad credentials');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  const runOne = (entry: Record<string, unknown>): Record<string, unknown> => {
    const query = typeof entry.query === 'string' ? entry.query : '';
    const variables = (typeof entry.variables === 'object' && entry.variables !== null ? entry.variables : {}) as Record<string, unknown>;
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
    const ctx: GqlContext = { variables, fragments: new Map(), errors: [] };
    try {
      const document = new GqlParser(tokenizeGql(query)).parseDocument();
      ctx.fragments = document.fragments;
      let operation = document.operations[0];
      if (operationName) operation = document.operations.find((op) => op.name === operationName) ?? operation;
      if (!operation) return { errors: [{ message: 'No operation found' }] };
      const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
      const data = executeSelection(null, rootType, operation.selection, ctx);
      const result: Record<string, unknown> = { data };
      if (ctx.errors.length) result.errors = ctx.errors;
      return result;
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => runOne(entry as Record<string, unknown>)));
    return;
  }
  sendJson(res, 200, runOne(parsed as Record<string, unknown>));
}

// ------------------------------------------------------------------ MCP endpoint

interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
  run: (args: Record<string, unknown>) => unknown;
}

function toolText(value: unknown): { content: { type: 'text'; text: string }[]; structuredContent?: unknown; isError?: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function toolError(message: string): { content: { type: 'text'; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function needRepo(args: Record<string, unknown>): Repo {
  const owner = String(args.owner ?? VIEWER.login);
  const name = String(args.repo ?? args.name ?? '');
  const repo = findRepo(owner, name);
  if (!repo) throw new Error(`repository ${owner}/${name} not found`);
  return repo;
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
    run: (args) => {
      const name = String(args.name ?? '');
      if (!name) throw new Error('name is required');
      if (repos.has(repoKey(VIEWER.login, name))) throw new Error('repository already exists');
      const repo = createRepo(name, args.private === true, String(args.description ?? ''));
      return repoShape(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
    run: (args) => repoShape(needRepo(args)),
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: () => [...repos.values()].filter((repo) => repo.owner === VIEWER.login).map(repoShape),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (args) => {
      const repo = needRepo(args);
      const issue: Issue = {
        id: nextObjectId++,
        number: repo.nextNumber++,
        title: String(args.title),
        body: String(args.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      repo.issues.push(issue);
      return issueShape(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
    run: (args) => {
      const repo = needRepo(args);
      const state = String(args.state ?? 'open');
      return repo.issues
        .filter((issue) => !issue.pullRequest && (state === 'all' || issue.state === state))
        .map((issue) => issueShape(repo, issue));
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'number', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    run: (args) => {
      const repo = needRepo(args);
      const issue = findIssue(repo, Number(args.issue_number), false);
      if (!issue) throw new Error('issue not found');
      return issueShape(repo, issue);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (args) => {
      const repo = needRepo(args);
      const headSha = branchTip(repo, String(args.head));
      const baseSha = branchTip(repo, String(args.base));
      if (!headSha || !baseSha) throw new Error('head or base branch not found');
      const issue: Issue = {
        id: nextObjectId++,
        number: repo.nextNumber++,
        title: String(args.title),
        body: String(args.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        pullRequest: { headRef: String(args.head), baseRef: String(args.base), headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null },
      };
      repo.issues.push(issue);
      return pullShape(repo, issue);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
        merge_method: { type: 'string', description: 'merge, squash or rebase' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (args) => {
      const repo = needRepo(args);
      const issue = findIssue(repo, Number(args.pull_number), true);
      if (!issue) throw new Error('pull request not found');
      const method = String(args.merge_method ?? 'merge').toLowerCase();
      const sha = performMerge(repo, issue, method);
      if (!sha) throw new Error('pull request is not mergeable');
      return { ...pullShape(repo, issue), merged: true, sha };
    },
  },
];

const MCP_SERVER_INFO = { name: 'makefun-forge', version: '1.0.0', title: 'make.fun forge' };
const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

async function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  if (!hasAuthHeader(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const isNotification = (entry: Record<string, unknown>): boolean => !('id' in entry) || entry.id === undefined;
  const handleOne = (entry: Record<string, unknown>): Record<string, unknown> | null => {
    const id = (entry.id ?? null) as string | number | null;
    const method = String(entry.method ?? '');
    const params = (typeof entry.params === 'object' && entry.params !== null ? entry.params : {}) as Record<string, unknown>;
    if (isNotification(entry)) return null;
    switch (method) {
      case 'server/discover':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'complete',
            supportedVersions: MCP_VERSIONS,
            capabilities: { tools: { listChanged: false } },
            serverInfo: MCP_SERVER_INFO,
            instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
          },
        };
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_VERSIONS[1];
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: MCP_VERSIONS.includes(requested) ? requested : MCP_VERSIONS[1],
            capabilities: { tools: { listChanged: false } },
            serverInfo: MCP_SERVER_INFO,
            instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: MCP_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
          },
        };
      case 'tools/call': {
        const name = String(params.name ?? '');
        const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
        const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
        if (!tool) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        }
        const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
        if (missing.length) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `Missing required arguments: ${missing.join(', ')}` } };
        }
        try {
          return { jsonrpc: '2.0', id, result: toolText(tool.run(args)) };
        } catch (err) {
          return { jsonrpc: '2.0', id, result: toolError(err instanceof Error ? err.message : String(err)) };
        }
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  };

  if (Array.isArray(parsed)) {
    const results = parsed
      .map((entry) => handleOne(entry as Record<string, unknown>))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    if (results.length === 0) {
      res.writeHead(202, { 'x-github-request-id': `req-${++requestCounter}` });
      res.end();
      return;
    }
    sendJson(res, 200, results);
    return;
  }
  const entry = parsed as Record<string, unknown>;
  const result = handleOne(entry);
  if (result === null) {
    res.writeHead(202, { 'x-github-request-id': `req-${++requestCounter}` });
    res.end();
    return;
  }
  if (req.headers['mcp-session-id'] === undefined && entry.method === 'initialize') {
    sendJson(res, 200, result, { 'mcp-session-id': 'forge-session-1' });
    return;
  }
  sendJson(res, 200, result);
}

// ------------------------------------------------------------------ the server

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          await handleRest(req, res, url, rawBody);
          return;
        }
        if (path === '/api/graphql' && method === 'POST') {
          await handleGraphql(req, res, rawBody);
          return;
        }
        if (path === '/mcp' && (method === 'POST' || method === 'GET' || method === 'DELETE')) {
          if (method !== 'POST') {
            if (!hasAuthHeader(req)) {
              sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
              return;
            }
            sendJson(res, 200, { jsonrpc: '2.0', id: null, result: {} });
            return;
          }
          await handleMcp(req, res, rawBody);
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const name = decodeURIComponent(gitMatch[2]);
          const repo = findRepo(owner, name);
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const tail = gitMatch[3];
          if (tail === 'info/refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 403, { message: 'Unsupported service' });
              return;
            }
            const protocol = String(req.headers['git-protocol'] ?? '');
            const v2 = service === 'git-upload-pack' && protocol.includes('version=2');
            sendRaw(res, 200, infoRefs(repo, service, v2), `application/x-${service}-advertisement`);
            return;
          }
          if (tail !== 'info/refs' && method === 'POST') {
            const service = tail;
            await handleGitPost(req, res, repo, service, rawBody);
            return;
          }
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (err instanceof HttpError) {
          sendJson(res, err.status, { message: err.message });
          return;
        }
        sendJson(res, 500, { message: 'Internal Server Error' });
      }
    })();
  });
}
