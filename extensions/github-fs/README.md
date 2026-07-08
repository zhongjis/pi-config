# github-fs

Read GitHub issues, pull requests, diffs, and repo files as `read` paths — GitHub is just another filesystem. No separate GitHub view tool: the model learns one path grammar and `read` handles paging, anchors, and truncation.

## What It Does

- Intercepts `read` calls whose `path` is a `pr://`, `issue://`, or `github://` URI
- Fetches the item via the `gh` CLI, renders it to markdown, materializes it to a cache file, and rewrites `input.path` to that file so the built-in `read` tool pages it normally
- Rewrites the backing cache path back to the original `pr://`/`issue://`/`github://` URI in the tool result
- Blocks `write`/`edit` on these paths — the views are read-only (use the `gh` CLI to mutate)
- Resolves multi-account access dynamically per repo; caches rendered views across sessions

## Path Grammar

```
pr://123                     issue://123                 single item, repo from cwd git remote
pr://owner/repo/123          issue://owner/repo/123      fully qualified
pr://                        issue://                    list recent items (current repo)
pr://owner/repo              issue://owner/repo          list recent items (that repo)
pr://123/diff                                            changed-file list
pr://123/diff/all                                        full unified diff
pr://123/diff/2                                          one file's diff (1-based)
github://owner/repo/path/to/file.ts   a repo file (real extension, line ranges work)
github://owner/repo/path/to/dir       one-level directory listing
github://owner/repo                   repo root listing
```

Query flags: `?comments=0` (hide comments), `?state=open|closed|merged|all`, `?limit=<n>`,
`?author=<login>`, `?label=<name>`, `?host=<ghe-host>`, `?refresh=1` (bypass cache).
`issue://` does not support `/diff` or `state=merged`.

`github://` adds `?ref=<branch|tag|sha>` to pin a version (default branch otherwise) and reuses `?host=`/`?refresh=1`.

## Host & Auth

- Host: `?host=` override → cwd `origin` remote host → `github.com` fallback. Repo defaults to the cwd remote when the path omits `owner/repo`. SSH remotes whose host is a `~/.ssh/config` alias (e.g. `github.com-work`) are canonicalized to the real hostname via `ssh -G`.
- Multi-account: enumerates `gh auth status` accounts, probes `gh api repos/{owner}/{repo}` per account until one has access, and injects that account's token via per-spawn env (`GH_TOKEN` / `GH_ENTERPRISE_TOKEN`). Never runs `gh auth switch`; never logs tokens.
- `github://` reuses the same host/account resolution but is fully-qualified (`owner/repo` required), so only the host is derived from the cwd remote. Pass `?host=github.com` to read github.com from inside an enterprise checkout.

## Cache

- Location: `~/.pi/agent/github-fs-cache/` (dir `0700`, files `0600`), cross-session.
- Key includes resolved account identity (a consistency control, not a trust boundary).
- Freshness: `?refresh=1` always refetches; terminal items (merged/closed) are served indefinitely; otherwise a 5-minute soft TTL. Entries past a 7-day hard TTL are evicted opportunistically on write.
- `github://` with a full 40-hex-SHA `?ref=` is treated as immutable (cached indefinitely); branch/tag/short-sha/omitted refs use the soft TTL. Fetched files materialize with their real extension (e.g. `.ts`) so `read` gives language-aware summaries and anchors; directory/PR/issue views stay `.md`.

## Hooks

- `tool_call` — rewrite `pr://`/`issue://`/`github://` read paths to a cache file; block `write`/`edit`
- `tool_result` — rewrite the cache path back to the virtual path
- `tool_execution_end` / `session_start` — clean up resolution tracking
- `before_agent_start` — append the path grammar to the system prompt

## Files Worth Reading

- `index.ts` — hooks + composition root
- `resolve.ts` — host/repo derivation + fetch/cache orchestration
- `parse.ts` — URI grammar
- `gh.ts` — `gh` spawn layer + multi-account auth
- `render.ts` — JSON/diff → markdown
- `cache.ts` — account-scoped file cache

## Out Of Scope

Search and mutations (create/checkout/push, Actions) are not paths — use the `gh` CLI/skill.
