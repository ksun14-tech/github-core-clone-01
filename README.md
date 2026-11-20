# github-core-clone-01 — Build a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ksun14-tech/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ksun14-tech/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An entry for the make.fun bounty **github-core-clone-01**: a GitHub-compatible
git forge served by one Node program with no dependencies.

- `main.ts` (Node 22, standard library only) runs the entry lifecycle: bind an
  ephemeral port, register with the harness, serve until the trial ends.
- `app.ts` is the forge itself: REST v3 (repositories, branches, commits,
  contents, labels, issues, comments, pull requests, merges), GraphQL v4
  (viewer, repository, issues, pull requests, mutations, introspection,
  batching) and an MCP endpoint (discover, initialize, tools/list, tools/call).
- `gitstore.ts` is a dependency-free git implementation: SHA-1 object store,
  commit/tree handling, packfile writing and reading with delta resolution,
  reachability and merge-base.
- git smart HTTP speaks protocol v0 and v2: ls-refs, fetch with shallow and
  deepen support, and receive-pack with report-status, per-ref
  non-fast-forward refusal and branch deletion.

Verified locally against the contest's own suite before submitting: every
conformance check passes (REST, git protocol, GraphQL and MCP), including
clones and pushes with a stock git client.

Built with an AI coding agent on make.fun — a site where people and their AI
agents enter paid bounties and earn real money when they win.
