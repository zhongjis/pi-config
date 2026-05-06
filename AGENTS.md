# panda-harness

**Generated:** 2026-04-23T20:25:33-07:00
**Commit:** 0ddbd6d
**Branch:** main

## Overview
Personal Pi harness around `pi`: custom agents, runtime extensions, test harnesses, and Nix-managed local setup.

## Structure
```
./
├── agents/          # custom agent definitions; Chinese mythology naming
├── extensions/      # runtime Pi extensions; most active product code
├── test/            # root Vitest smoke + integration harness
├── docs/            # design docs, standards, and reference material
└── scripts/         # repo helper scripts used by root flows
```

## Where to Look
| Task | Location | Notes |
|------|----------|-------|
| Change agent behavior | `agents/` | Frontmatter + prompts; root naming rules still apply |
| Build or debug a Pi extension | `extensions/AGENTS.md` | Child file covers layout tiers, events, smoke-test assumptions |
| Change subagent orchestration | `extensions/subagent/AGENTS.md` | Eventbus RPC + background-agent lifecycle |
| Change task tracking flow | `extensions/tasks/AGENTS.md` | Task DAG, storage, subagent bridge |
| Change web search/fetch tools | `extensions/web-access/AGENTS.md` | Provider fallbacks, curator, GitHub/video paths |
| Change install/symlink behavior | `install.sh` | Allowlist + Nix-managed skip rules |
| Change repo-wide tests | `docs/testing/README.md`, `vitest.config.ts`, `test/` | Unit uses stubs; integration uses real pi runtime |

## Commands
```bash
direnv allow && direnv reload
nix develop
pnpm test
pnpm test:extensions
pnpm test:integration
pnpm lint:typecheck
bash install.sh
```

## Minimal Tools

**Check existing before adding. Compose before building.**

Before registering any new tool, extension, or MCP server:

1. **Audit the registry below.** A tool may already exist in `extensions/` or a remote package in `settings.json`.
2. **No speculative tools.** Tools exist to serve current, concrete workflows — not hypothetical future use.
3. **Compose first.** `bash` + existing tools covers most needs. A new tool = new test surface, new docs, new maintenance.
4. **MCP via mcporter.** This harness uses `pi-mcporter` as a unified MCP proxy. Route through `mcporter`; don't add standalone MCP servers.

### Extension & Package Registry

| Capability | Source |
|---|---|
| Interactive user prompts (questions, select) | `extensions/ask` |
| Shell with cwd | `extensions/better-bash-tool` |
| Read-only validated shell | `extensions/readonly-bash` |
| Subagent orchestration (Agent, get_subagent_result, steer_subagent) | `extensions/subagent` |
| Task tracking + DAG (TaskCreate/Update/List/Get/Execute) | `extensions/tasks` |
| Web search, fetch, code search, video | `extensions/web-access` |
| MCP tools proxy | `pi-mcporter` package → `mcporter` tool |
| Git diff viewer | `extensions/diff` |
| Context save/restore + pruning | `extensions/context-management` |
| Session-local file storage (`local://`) | `extensions/session-local` |
| Secrets redaction from tool outputs | `extensions/filter-outputs` |
| Code knowledge graph (GitNexus) | `extensions/gitnexus` |
| Session handoff to new focused session | `extensions/handoff` |
| Token-efficient background task execution | `extensions/boomerang` |
| Agent modes (kuafu / fuxi / houtu / etc.) | `extensions/modes` |
| AGENTS.md generation | `extensions/init-deep` |
| Mermaid diagram rendering | `pi-mermaid` package |
| Thinking steps visualization | `pi-thinking-steps` package |
| Guardrails | `pi-guardrails` package |
| Autoresearch experiment loop | `pi-autoresearch` package |
| Plan annotation | `plannotator` package |

## Always
- Keep root guidance repo-wide only; push extension-only rules into `extensions/AGENTS.md`.
- Treat root Vitest as two tiers: unit tests use stubs from `test/stubs/`; integration tests in `test/integration/` use the real pi runtime via `pi-test-harness`.
- Follow `extensions/CONVENTIONS.md` for `pi.events`: `user-prompted` for same-run blocking tool prompts, `awaitingUserAction.suppressContinuationReminder` for persisted waits, `<namespace>:rpc:<method>` plus `:reply:${requestId}` for RPC.
- Keep extension entrypoints as directories (`extensions/foo/index.ts`); no bare `.ts` files at the extensions root. Every extension directory must have a `README.md` (see `docs/extensions.md`).

## Ask First
- Broadening this repo from personal harness to shared/general-purpose harness.
- Changing event contracts consumed across extensions (`subagents:*`, `tasks:*`, shared `user-prompted`).

## Never
- Do **not** recommend or use `pi install npm:...` in this repo; NixOS setup expects git/local/repo-managed wiring instead.
- Do **not** assume `install.sh` syncs the whole repo; it symlinks an allowlist of runtime items only.
- Do **not** expect edits to repo `AGENTS.md`, `settings.json`, or `skills` to propagate into `~/.pi/agent/`; those are Home Manager / Nix managed there.
- Do **not** commit runtime state: `auth.json`, session logs, or extension cache/data.

## Gotchas
- `install.sh` skips `AGENTS.md`, `settings.json`, and `skills`; editing them here affects the repo, not the live Home Manager links.
- Git packages under `~/.pi/agent/git/...` with `package.json` get dependency installs automatically during `bash install.sh`; repo test/build files stay local.
- Root smoke coverage is centralized in `test/extensions.smoke.test.ts`; if a new extension needs custom discovery or setup, update that file with the extension.
- For broad searches or pruning noise only, exclude runtime/generated paths: `.codex/`, `.omx/`, `.pi/tasks/`, `.direnv/`, `node_modules/`, and runtime file `auth.json`.
- Do not delete runtime state unless user explicitly asks.

## References
- Extension-wide rules: `@extensions/AGENTS.md`
- Harness design overview: `@docs/README.md`
- Extension README standard: `@docs/extensions.md`
- Testing overview: `@docs/testing/README.md`
- Event conventions: `@extensions/CONVENTIONS.md`

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **pi-config** (7439 symbols, 12580 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/pi-config/context` | Codebase overview, check index freshness |
| `gitnexus://repo/pi-config/clusters` | All functional areas |
| `gitnexus://repo/pi-config/processes` | All execution flows |
| `gitnexus://repo/pi-config/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
