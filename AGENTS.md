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
| Change web search/fetch tools | `extensions/pi-web-access/AGENTS.md` | Provider fallbacks, curator, GitHub/video paths |
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
