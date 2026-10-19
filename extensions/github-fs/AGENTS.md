## Purpose

Expose GitHub issues, PRs, diffs, and repository contents as read-only file views.

## Ownership

- Owns URI parsing, host/account resolution, fetching, rendering, and cached read interception.
- The `gh` CLI owns authenticated GitHub transport; mutations remain outside virtual paths.

## Local Contracts

- Virtual views MUST reject write/edit and page only through native `read` `offset`/`limit`; NEVER add path-suffix selectors.
- Tool results MUST show the canonical virtual path (also for translated web URLs), not the cache filename.
- Cache keys MUST include the render version; bump it in [cache.ts](cache.ts) whenever rendered output changes.
- Optional PR view sections (review threads) MUST degrade to an inline notice on failure, never fail the read.
- Account selection MUST use per-spawn credentials; NEVER switch global auth or log tokens.
- Cache keys MUST include resolved account identity; this is consistency, not a trust boundary.
- Cache directories/files MUST retain owner-only permissions.
- Refresh, mutable refs, and immutable full-SHA refs MUST retain distinct freshness behavior.

## Work Guidance

- [README](README.md) owns URI grammar, host precedence, auth probing, and cache lifetimes.
- Fully qualified repository paths MUST NOT inherit the cwd host unless they name the cwd `origin` repository.
- Search and mutations SHOULD use `gh`, not new virtual-path operations.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/github-fs/test`.
- [Parsing](test/parse.test.ts), [auth](test/gh.test.ts), and [cache](test/cache.test.ts) cover input and account boundaries.

## Child DOX Index

- None; this document owns the entire subtree.
