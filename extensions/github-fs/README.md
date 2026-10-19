# github-fs

Read GitHub repos, pull requests, issues, and diffs with the `read` tool as if they were local files. No separate GitHub view tool: the agent learns one path grammar, and `read` handles paging with `offset`/`limit`.

## What It Does

- Intercepts `read` calls whose `path` is a `gh://`, `gh-pr://`, or `gh-issue://` path, or a pasted GitHub web URL
- Fetches the item via the `gh` CLI, renders it, materializes it to a cache file, and rewrites `input.path` to that file so the built-in `read` tool pages it normally
- Rewrites the backing cache path back to the canonical virtual path in the tool result
- Blocks `write`/`edit` on these paths — the views are read-only (use the `gh` CLI to mutate, or clone to edit)
- Resolves multi-account access dynamically per repo; caches rendered views across sessions

## Path Grammar

```
gh://owner/repo/                  repo root listing
gh://owner/repo/src/              directory listing
gh://owner/repo/src/a.ts          file contents (real extension, so read pages it like source)
gh://<host>/owner/repo/...        GitHub Enterprise host prefix

gh-pr://                          PR list, current repo
gh-pr://owner/repo                PR list, that repo
gh-pr://123                       PR: description, reviews, review threads, checks, comments
gh-pr://owner/repo/123            same, that repo
gh-pr://123/diff                  changed files with +/- counts and status
gh-pr://123/diff/src/a.ts         one file's diff
gh-pr://123.diff                  full unified diff

gh-issue://   gh-issue://owner/repo   gh-issue://123   gh-issue://owner/repo/123
```

- A trailing slash never changes the result; GitHub decides whether a path is a file or a directory.
- Query parameters: `gh://` takes `?ref=<branch|tag|sha>` (default branch otherwise). Lists take `?state=`, `?limit=`, `?author=`, `?label=`. Every form takes `?refresh=1` to bypass the cache. Unknown parameters are rejected.
- `gh-issue://` is GitHub-only; a tracker key such as `ABC-123` gets a pointer to the Jira skill.
- Pasted `github.com`, `raw.githubusercontent.com`, and logged-in Enterprise links (`/blob`, `/tree`, `/pull`, `/pull/N/files`, `/issues`, repo root) translate to the canonical path; `#L10-L20` becomes `offset`/`limit`.
- Listings and views print full copyable paths for the next read.

## Host & Auth

- Host: an explicit `<host>/` prefix wins. Short forms (`gh-pr://123`, `gh-pr://`) use the cwd `origin` remote. A qualified `owner/repo` without a prefix means `github.com`, unless it matches the cwd `origin` repo. SSH host aliases (e.g. `github.com-work`) are canonicalized via `ssh -G`.
- Multi-account: enumerates `gh auth status` accounts. With one account for the host it is used directly; otherwise each is probed with `gh api repos/{owner}/{repo}` until one has access. The token is injected via per-spawn env (`GH_TOKEN` / `GH_ENTERPRISE_TOKEN`). Never runs `gh auth switch`; never logs tokens.

## Cache

- Location: `~/.pi/agent/github-fs-cache/` (dir `0700`, files `0600`), cross-session. Keys include the resolved account and a render version.
- Freshness: `?refresh=1` always refetches; merged PRs and full-40-hex-SHA `?ref=` reads are immutable; everything else uses a short soft TTL. A PR's raw diff is fetched once and shared by its diff views. See [`cache.ts`](cache.ts) for TTLs.

## Entry Points

There is no separate tool: `read` a path above. The hooks and the prompt section are registered in [`index.ts`](index.ts); the grammar is parsed in [`parse.ts`](parse.ts).

## Out Of Scope

Search and mutations (create, comment, review, resolve threads, checkout, push, Actions) are not paths — use the `gh` CLI/skill. Shell tools such as `rg` and `ls` cannot see virtual paths.
