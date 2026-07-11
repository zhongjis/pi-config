# panda-harness

**Generated:** 2026-04-23T20:25:33-07:00
**Commit:** 0ddbd6d
**Branch:** main

## Overview
Personal Pi harness around `pi`: custom agents, runtime extensions, test harnesses, and Nix-managed local setup.

## DOX Contract

Source: `agent0ai/dox` at `5cb5ba55bd1c0f7c1b31fe655fe36e2febb760d2` (MIT, Copyright 2026 Agent Zero). Adopted as a documentation/process layer, not as a Pi extension or package.

- `AGENTS.md` files are binding work contracts for their subtrees.
- Before editing, identify expected target paths and read the applicable chain: root `AGENTS.md` → every child `AGENTS.md` on the path → nearest owning `AGENTS.md`.
- The nearest `AGENTS.md` controls local work details. Parent docs still control repo-wide rules; child docs must not weaken this root contract.
- After meaningful changes to structure, ownership, workflows, contracts, verification, permissions, side effects, or durable user preferences, update the nearest owning `AGENTS.md` and any affected parent/child index before finishing.
- Tiny behavior-neutral edits may leave docs unchanged, but still do the DOX pass and report docs intentionally unchanged when relevant.
- Keep docs concise, operational, and current. Delete stale or contradictory guidance instead of explaining history.

## Child DOX Index

| Path | Owner Doc | Scope |
|------|-----------|-------|
| `.agents/` | `.agents/AGENTS.md` | Repo-local agent skills and skill source snapshots. |
| `agents/` | `agents/AGENTS.md` | Custom subagent definitions and prompt/frontmatter conventions. |
| `docs/` | `docs/AGENTS.md` | Human-facing design docs, testing notes, and references. |
| `extensions/` | `extensions/AGENTS.md` | Runtime Pi extensions, shared extension rules, event contracts, and extension-local child docs. |
| `modes/` | `modes/AGENTS.md` | Mode prompt variants and prompt-family construction rules. |
| `scripts/` | `scripts/AGENTS.md` | Repo helper scripts used by install/test/maintenance flows. |
| `test/` | `test/AGENTS.md` | Root Vitest smoke/integration harness, fixtures, and stubs. |
| `themes/` | `themes/AGENTS.md` | Theme JSON assets. |

## Where to Look
| Task | Location | Notes |
|------|----------|-------|
| Change agent behavior | `agents/` | Frontmatter + prompts; root naming rules still apply |
| Build or debug a Pi extension | `extensions/AGENTS.md` | Child file covers layout tiers, events, smoke-test assumptions |
| Change subagent orchestration | `extensions/subagent/AGENTS.md` | Eventbus RPC + background-agent lifecycle |
| Change task tracking flow | `extensions/tasks/AGENTS.md` | Task DAG, storage, subagent bridge |
| Change web search/fetch tools | `pi-web-access` git package (`settings.json`) | Vendored remote, not a local extension; model wiring → `docs/specs/extension-model-usage.md` |
| Change shared extension model roles | `extensions/lib/tool-models.ts`, `docs/specs/extension-model-usage.md` | `tool_models.json` roles bind extension-owned LLM calls to model chains |
| Change install/symlink behavior | `install.sh` | Allowlist + Nix-managed skip rules |
| Change repo-wide tests | `docs/specs/testing/README.md`, `vitest.config.ts`, `test/` | Unit uses stubs; integration uses real pi runtime |

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
| Web search, fetch, code search, video | `pi-web-access` git package (`settings.json`) |
| MCP tools proxy | `pi-mcporter` package → `mcporter` tool |
| Git diff viewer | `extensions/diff` |
| Session-local file storage (`local://`) | `extensions/session-local` |
| GitHub issues/PRs/diffs and repo files as read paths (`pr://`, `issue://`, `github://`) | `extensions/github-fs` |
| Secrets redaction from tool outputs | `extensions/filter-outputs` |
| Code knowledge graph | `extensions/codegraph` |
| Session handoff to new focused session | `extensions/handoff` |
| Token-efficient background task execution | `extensions/boomerang` |
| Agent modes (kuafu / fuxi / houtu / luban / shennong) | `extensions/modes` |
| Product-manager mode PM skill pack + /pm:* commands (神農, vendored pm-skills) | `extensions/pm-marketplace` |
| AGENTS.md generation | `extensions/init` |
| Mermaid diagram rendering | `pi-mermaid` package |
| Thinking steps visualization | `pi-thinking-steps` package |
| Guardrails | `pi-guardrails` package |
| Autoresearch experiment loop | `pi-autoresearch` package |
| Plan annotation | `plannotator` package |

## Always
- Keep root guidance repo-wide only; push extension-only rules into `extensions/AGENTS.md`.
- Treat root Vitest as two tiers: unit tests use stubs from `test/stubs/`; integration tests in `test/integration/` use the real pi runtime via `pi-test-harness`.
- Follow `extensions/CONVENTIONS.md` for `pi.events`: `user-prompted` for same-run blocking tool prompts, `awaitingUserAction.suppressContinuationReminder` for persisted waits, `<namespace>:rpc:<method>` plus `:reply:${requestId}` for RPC.
- Keep extension entrypoints as directories (`extensions/foo/index.ts`); no bare `.ts` files at the extensions root. Every extension directory must have a `README.md` (see `docs/specs/extensions.md`).

## Ask First
- Broadening this repo from personal harness to shared/general-purpose harness.
- Changing event contracts consumed across extensions (`subagents:*`, `tasks:*`, shared `user-prompted`).

## Never
- Do **not** recommend or use `pi install npm:...` in this repo; NixOS setup expects git/local/repo-managed wiring instead.
- Do **not** assume `install.sh` syncs the whole repo; it symlinks an allowlist of runtime items only.
- Do **not** expect edits to repo `AGENTS.md` or `settings.json` to propagate into `~/.pi/agent/`; those are Home Manager / Nix managed there.
- Do **not** commit runtime state: `auth.json`, session logs, or extension cache/data.

## Gotchas
- `install.sh` skips `AGENTS.md` and `settings.json`; editing them here affects the repo, not the live Home Manager links.
- Git packages under `~/.pi/agent/git/...` with `package.json` get dependency installs automatically during `bash install.sh`; repo test/build files stay local.
- Root smoke coverage is centralized in `test/extensions.smoke.test.ts`; if a new extension needs custom discovery or setup, update that file with the extension.
- For broad searches or pruning noise only, exclude runtime/generated paths: `.codex/`, `.omx/`, `.pi/tasks/`, `.direnv/`, `node_modules/`, and runtime file `auth.json`.
- Do not delete runtime state unless user explicitly asks.

## References
- Extension-wide rules: `@extensions/AGENTS.md`
- Harness design overview: `@docs/README.md`
- Extension README standard: `@docs/specs/extensions.md`
- Testing overview: `@docs/specs/testing/README.md`
- Event conventions: `@extensions/CONVENTIONS.md`
