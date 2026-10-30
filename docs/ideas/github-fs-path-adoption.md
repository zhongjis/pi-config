# Improving adoption of github-fs read paths

Status: idea

## Summary

Agents still reach for `gh`, `curl`, and `fetch_content` to read GitHub even though
[`extensions/github-fs/`](../../extensions/github-fs/) serves `gh://`, `gh-pr://`, and
`gh-issue://` paths through `read`. The remaining causes sit outside the extension:
competing skills and worker routing.

## Remaining causes

1. **Competing skills win the reflex.** The `gh` skill, the `code-review` skill's
   `references/pr-workflow.md`, and the `address-comments` skill (all Nix-managed, in
   `~/personal/nix-config`) tell agents to read PRs with `gh pr view`, `gh pr diff`, and
   `gh api …/pulls/N/{reviews,comments}`, with no cross-reference to the paths.
2. **`fetch_content` advertises GitHub support** as an always-visible tool.
3. **Routing mismatch.** `wenchang` — the worker most likely to fetch GitHub content —
   is steered to commit-pinned permalinks via `fetch_content` / `code_search`.

## Proposed levers (cheapest first)

1. Point the read steps of the `gh`, `code-review`, and `address-comments` skills at
   `gh-pr://` / `gh://`; keep `gh` for search and mutations.
2. Re-point `wenchang` at `gh://` / `gh-pr://` for GitHub reads before `fetch_content`.
3. Verify that `before_agent_start` fires for subagent `session.prompt()` runs, so
   workers receive the `github_fs` prompt section: assert a running worker's effective
   system prompt contains it.

## Relevant code

- [`extensions/github-fs/index.ts`](../../extensions/github-fs/index.ts) — hooks and prompt section
- [`extensions/github-fs/url.ts`](../../extensions/github-fs/url.ts) — pasted GitHub URL translation
- [`extensions/subagents/src/agent-runner.ts`](../../extensions/subagents/src/agent-runner.ts) — subagent extension loading and binding
- [`agents/wenchang/default.md`](../../agents/wenchang/default.md) — worker tool scoping
