# Improving adoption of github-fs read paths

Status: idea

## Summary

Agents underuse the `github://`, `pr://`, and `issue://` read paths provided by
`extensions/github-fs/`, with `github://` the most neglected. The extension is
wired correctly — the path grammar reaches the main agent and every non-isolated
subagent — so this is a behavioral adoption gap, not a wiring bug. The cause is a
combination of low prompt salience, competition from more prominently advertised
tools, `github://`-specific friction, and a routing mismatch where the worker most
likely to fetch GitHub content is tool-scoped away from these paths.

## Current behavior (wiring is fine)

- `github-fs` is a **pure hook extension**: it registers no tools, only
  `tool_call` / `tool_result` / `before_agent_start` hooks
  (`extensions/github-fs/index.ts`).
- `before_agent_start` appends `PROMPT_GUIDE` — the exact `## GitHub virtual paths`
  block — to the system prompt (`extensions/github-fs/index.ts:71-84, 262-266`).
- Because github-fs registers no tools, worker `extension_tools` allowlists cannot
  gate it. Only `extensions: true | false | list` controls whether its hooks load.
- Workers that omit `extensions:` default to `true`
  (`extensions/lib/agent-frontmatter.ts` `inheritField(undefined) → true`), so the
  extension loads and its hooks bind for all non-isolated workers. The grammar
  therefore reaches main agent and workers alike.

## Why the paths are underused

1. **Low salience.** `PROMPT_GUIDE` is appended at the very end of an already large
   system prompt (mode body + skills catalog + `AGENTS.md` chain). Passive tail
   guidance loses to trained-in defaults. It is static prompt text, not a triggered
   skill, so nothing re-surfaces it at the moment of need.

2. **Competing tools win the reflex.**
   - `fetch_content` explicitly advertises "GitHub repository contents" as a
     first-class, always-visible tool, directly cannibalizing `github://`.
   - The `gh` CLI plus the `gh` skill trigger on GitHub verbs ("list issues",
     "view PR", "GitHub API") and contain **no cross-reference** to the read paths,
     reinforcing `gh issue view` / `gh pr view` / `gh api` muscle memory.
   - When a repo is checked out locally, the plain `read` reflex covers file access.

3. **`github://` carries extra friction (why it is the biggest loser).**
   - It always requires a fully-qualified `owner/repo`. `pr://123` and `issue://123`
     derive the repo from the cwd remote (zero friction); `github://` never does
     (`extensions/github-fs/parse.ts:339` throws on `<2` segments; `ContentTarget.repo`
     is non-optional). The agent must already know owner/repo, so use is not reflexive.
   - Its unique value — read a repo file without cloning, at any ref, from any repo —
     overlaps three stronger habits: local `read`, `fetch_content` (which loudly
     claims GitHub support), and `gh api` / raw URLs. `pr://` and `issue://` have no
     local-file equivalent, so their unique value is clearer. The prompt gives
     `github://` a single terse bullet and never sells its "no clone, any ref" niche.

4. **Routing mismatch.** `wenchang` — the external-research worker most likely to
   fetch GitHub content — is tool-scoped to
   `web_search,code_search,fetch_content,get_search_content,mcporter`, and its prompt
   pushes commit-pinned GitHub permalinks via `fetch_content` / `code_search`,
   steering away from `github://`. `chengfeng` is local-only recon
   (`codegraph_*` / `readonly_bash`) and rarely reaches remote GitHub. Even though the
   grammar is present in their prompts, their tool identity and instructions route
   around it.

## Open verification item

github-fs is confirmed to *load* for workers (hooks bind via
`session.bindExtensions()` in `extensions/subagent/src/agent-runner.ts`), but it is
not confirmed that pi emits `before_agent_start` for programmatic subagent
`session.prompt()` runs. If that event does not fire for subagent sessions, workers
never receive `PROMPT_GUIDE` at all — a stronger, structural cause. Verify by
asserting a running worker's effective system prompt contains the
`## GitHub virtual paths` block.

## Proposed levers (cheapest first)

1. **Cross-reference the paths in the `gh` skill.** Add a note preferring
   `pr://` / `issue://` / `github://` for viewing and reserving the `gh` CLI for
   mutations. This hits agents exactly when GitHub intent triggers.
2. **Re-point `wenchang`** at `github://` / `pr://` for GitHub reads before, or
   instead of, `fetch_content`.
3. **Sell `github://`'s unique value in `PROMPT_GUIDE`** ("read any repo file at any
   ref without cloning; prefer over fetch_content / gh api for GitHub file reads")
   and move the block higher, e.g. into a mode preamble.
4. **Close the open verification item** on subagent `before_agent_start` firing.

## Relevant code

- `extensions/github-fs/index.ts` — hooks, `PROMPT_GUIDE`, read-path rewrite
- `extensions/github-fs/parse.ts` — URI grammar; `github://` owner/repo requirement
- `extensions/github-fs/README.md` — path grammar reference
- `extensions/lib/agent-frontmatter.ts` — `extensions:` default resolution
- `extensions/subagent/src/agent-runner.ts` — subagent extension loading and binding
- `agents/wenchang.md`, `agents/chengfeng.md` — worker tool scoping
- `~/.pi/agent/skills/gh/SKILL.md` — competing CLI skill (no path cross-reference)
