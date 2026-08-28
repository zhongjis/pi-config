# DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits

## Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it

## Read Before Editing

1. Read the root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path, read that child and continue from there
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules
7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.

## Hierarchy

- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index
- Child AGENTS.md files own domain-specific instructions and their own Child DOX Index
- Each parent explains what its direct children cover and what stays owned by the parent
- The closer a doc is to the work, the more specific and practical it must be

## Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its own purpose, rules, responsibilities, workflow, materials, or quality standards
- Work Guidance must reflect the current standards of the project or user instructions; if there are no specific standards or instructions yet, leave it empty
- Verification must reflect an existing check; if no verification framework exists yet, leave it empty and update it when one exists

Default section order:
- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

## Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local version
- Delete stale notes instead of explaining history
- Trim obvious statements, repeated rules, misplaced detail, and warnings for risks that no longer exist

## Closeout

1. Re-check changed paths against the DOX chain
2. Update nearest owning docs and any affected parents or children
3. Refresh every affected Child DOX Index
4. Remove stale or contradictory text
5. Run existing verification when relevant
6. Report any docs intentionally left unchanged and why

## User Preferences

When the user requests a durable behavior change, record it here or in the relevant child AGENTS.md

## Child DOX Index

| Path | Owner Doc | Scope |
|------|-----------|-------|
| `.agents/` | `.agents/AGENTS.md` | Repo-local agent skills and skill source snapshots. |
| `agents/` | `agents/AGENTS.md` | Custom subagent definitions and prompt/frontmatter conventions. |
| `docs/` | `docs/AGENTS.md` | Human-facing design docs, testing notes, and references. |
| `extensions/` | `extensions/AGENTS.md` | Runtime Pi extensions, shared extension rules, event contracts, and extension-local child docs. |
| `modes/` | `modes/AGENTS.md` | Mode prompt variants, prompt-family rules, mode-scoped skills, and provenance. |
| `scripts/` | `scripts/AGENTS.md` | Repo helper scripts used by install/test/maintenance flows. |
| `test/` | `test/AGENTS.md` | Root Vitest smoke/integration harness, fixtures, and stubs. |
| `themes/` | `themes/AGENTS.md` | Theme JSON assets. |

# panda-harness

**Generated:** 2026-04-23T20:25:33-07:00
**Commit:** 0ddbd6d
**Branch:** main

## Overview
Personal Pi harness around `pi`: custom agents, runtime extensions, test harnesses, and Nix-managed local setup.

## Where to Look
| Task | Location | Notes |
|------|----------|-------|
| Change agent behavior | `agents/` | Frontmatter + prompts; root naming rules still apply |
| Build or debug a Pi extension | `extensions/AGENTS.md` | Child file covers layout tiers, events, smoke-test assumptions |
| Change subagent orchestration | `extensions/subagents/AGENTS.md` | Eventbus RPC + background-agent lifecycle |
| Change task tracking flow | `extensions/tasks/AGENTS.md` | Task DAG, storage, process tracking, planning cleanup |
| Change web search/fetch tools | `pi-web-access` git package (`settings.json`) | Vendored remote, not a local extension; model wiring → `docs/specs/extension-model-usage.md` |
| Change shared extension model roles | `extensions/lib/tool-models.ts`, `docs/specs/extension-model-usage.md` | `tool_models.json` roles bind extension-owned LLM calls to model chains |
| Change install/symlink behavior | `install.sh` | Allowlist + Nix-managed skip rules |
| Change repo-wide tests | `docs/guides/testing/README.md`, `vitest.config.ts`, `test/` | Unit uses stubs; integration uses real pi runtime |
| Refresh Oh My OpenAgent final-prompt archive | `docs/references/oh-my-openagent/README.md`, `scripts/sync-oh-my-openagent-final-prompts.mjs` | `pnpm sync:oh-my-openagent-prompts` updates generated final prompts; `pnpm check:oh-my-openagent-prompts` verifies without writing. Active Pi-adapted `ulw-plan` lives under `modes/fuxi/skills/ulw-plan/`. |

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
| Scoped guard for selected built-in `bash` calls | `extensions/smart-tool-guards` |
| Subagent orchestration (Agent, get_subagent_result, steer_subagent) | `extensions/subagents` |
| Task tracking + DAG (single `Task` tool: op create/update/list/get) | `extensions/tasks` |
| Web search, fetch, code search, video | `pi-web-access` git package (`settings.json`) |
| MCP tools proxy | `pi-mcporter` package → `mcporter` tool |
| Git diff viewer | `extensions/diff` |
| Agent-tree-local file storage (`local://`) | `extensions/session-local` |
| GitHub issues/PRs/diffs and repo files as read paths (`pr://`, `issue://`, `github://`) | `extensions/github-fs` |
| Secrets redaction from tool outputs | `extensions/filter-outputs` |
| Code knowledge graph | `extensions/codegraph` |
| Session handoff to new focused session | `extensions/handoff` |
| Token-efficient background task execution | `extensions/boomerang` |
| Agent modes (kuafu / fuxi / houtu / luban / shennong / zhurong) | `extensions/modes` |
| Product-manager mode PM skill pack + /pm:* commands (神農, vendored pm-skills) | `extensions/pm-marketplace` |
| AGENTS.md generation | `extensions/init` |
| Inline `/skill` autocomplete + per-turn skill loading | `extensions/inline-skills` |
| Persistent Codex-style goal tracking (`/goal`, `create_goal`/`get_goal`/`update_goal`) | `extensions/goal` |
| Persistent Codex-style goal tracking (`/goal`, `create_goal`/`get_goal`/`update_goal`) | `extensions/goal` |
| Mermaid diagram rendering | `pi-mermaid` package |
| `Thinking Steps` renderer | `extensions/thinking-steps` |
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
- Git package dependency installs preserve each package's manager-native workspace config; `~/.pi/agent/git` topology provides isolation.
- `bash install.sh` runs a repo workspace `pnpm install` (via `install_repo_extension_deps`) so local workspace extensions with real runtime deps (e.g. `extensions/lsp` -> `effect`) resolve when pi loads the symlinked extension; without it, `node_modules` for those deps is never materialized.
- Root smoke coverage is centralized in `test/extensions.smoke.test.ts`; if a new extension needs custom discovery or setup, update that file with the extension.
- For broad searches or pruning noise only, exclude runtime/generated paths: `.codex/`, `.omx/`, `.pi/tasks/`, `.direnv/`, `node_modules/`, and runtime file `auth.json`.
- Do not delete runtime state unless user explicitly asks.

## References
- Extension-wide rules: `@extensions/AGENTS.md`
- Harness design overview: `@docs/README.md`
- Extension README standard: `@docs/specs/extensions.md`
- Testing overview: `@docs/guides/testing/README.md`
- Event conventions: `@extensions/CONVENTIONS.md`

## Agent skills

### Issue tracker

Issues tracked in GitHub Issues on `zhongjis/pi-config` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, label strings unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
