# extensions

## Overview
Runtime Pi extensions. All extensions live in directories with `index.ts` entrypoints. No bare `.ts` files at the top level.

## Structure
```
extensions/
├── <name>/              # each extension in its own directory
│   ├── index.ts         # entrypoint (required)
│   └── README.md        # documentation (required, see docs/extensions.md)
├── lib/                 # shared utilities (not an extension)
├── CONVENTIONS.md       # repo-wide event bus contract
└── AGENTS.md            # this file
```

## Where to Look
| Task | Location | Notes |
|------|----------|-------|
| Add simple extension | `extensions/foo/index.ts` + `README.md` | Flat directory tier |
| Add multi-file extension | `extensions/foo/index.ts` + `src/` + `test/` + `README.md` | Structured tier |
| Add complex extension | `extensions/foo/index.ts` + `src/` + `test/` + `package.json` + `README.md` | Package tier (vendored) |
| Shared event semantics | `CONVENTIONS.md` | Source of truth for `pi.events` usage |
| Subagents | `subagent/AGENTS.md` | High-coupling runtime/event surface |
| Tasks | `tasks/AGENTS.md` | File-backed task store + RPC bridge |
| Web research tools | `pi-web-access` git package (`settings.json`) | Vendored remote, not a local `extensions/` dir |
| Provider failover | `clauderock/` | Anthropic → AWS Bedrock fallback on quota/rate-limit; uses `lib/stream-fallback.ts` |
| Shared model roles | `lib/tool-models.ts`, `docs/extension-model-usage.md` | `tool_models.json` role schema for extension-owned LLM calls |
| Shared failover primitives | `lib/provider-errors.ts`, `lib/fallback-cache.ts`, `lib/stream-fallback.ts`, `lib/notify-once.ts` | Pure utilities; no extension state |

## Commands
```bash
pnpm test:extensions
pnpm lint:typecheck
```

## Always
- Entrypoint shape: `extensions/foo/index.ts` only. No bare `.ts` files at the extensions root.
- Every extension directory must have a `README.md`. Max ~120 lines, concise and factual:
  - One-paragraph summary, then sections for Tools, Commands, Hooks, Settings, Events as applicable.
  - No install instructions, badges, screenshots, developer guides, test matrices, or marketing copy.
  - Vendored extensions must include an `## Upstream` section (source URL, last synced version/tag, commit SHA, license).
  - Vendored extensions with local divergences must maintain a `## Local Tweaks` manifest in their `AGENTS.md` — current-state snapshot of what diverges from upstream and why.
  - Full format specs:
    - README: `.agents/skills/pi-extension-vendoring/SKILL.md` → README.md requirements.
    - Manifest: `.agents/skills/pi-extensions/references/local-tweaks-format.md`.
- Promote layout gradually: flat directory → `src/` package. Do not skip straight to deep nesting.
- For `src/` packages, keep `index.ts` as a re-export shim; implementation lives under `src/`, tests under `test/`.
- Extension-specific unit tests belong with the extension under `extensions/foo/test/`; root `test/` is for shared smoke, fixtures, stubs, and other harness coverage.
- Follow `CONVENTIONS.md` exactly for events:
  - `user-prompted` once before first blocking tool UI prompt
  - `awaitingUserAction.suppressContinuationReminder` for persisted waiting state
  - `<namespace>:<event>` for lifecycle broadcasts
  - `<namespace>:rpc:<method>` + `:reply:${requestId}` for RPC
- If a new extension needs special smoke handling, update `test/extensions.smoke.test.ts`.

## Ask First
- Adding a new shared event family or changing payload shapes consumed across extensions.
- Introducing a new nested package/toolchain inside an extension directory.
- Moving an extension between layout tiers when a smaller tier still fits.

## Never
- Never nest deeper than `extensions/foo/src/`; no `src/lib/`, `src/utils/`, or extra internal tree layers.
- Never invent ad-hoc reply channels or RPC envelopes; use `requestId`-scoped replies.
- Never rely on `pi install npm:...` as the recommended path in this repo.
- Never duplicate parent/root rules into child files; put only local constraints in child `AGENTS.md` files.

## Gotchas
- Root smoke discovery does not scan arbitrary nested entrypoints.
- Many extension tests rely on root Vitest aliases/stubs; run validation from repo root unless a package README says otherwise.
- `node_modules/` inside some extension folders are local package artifacts, not a signal to treat the whole repo as a workspace monorepo.

## Child DOX Index

Child `AGENTS.md` files own only local extension details. This file owns extension-wide rules and every extension directory not listed here.

| Path | Owner Doc | Scope |
|------|-----------|-------|
| `boomerang/` | `boomerang/AGENTS.md` | Vendored Boomerang extension sync notes and local `/boomerang:commit` tweaks. |
| `codegraph/` | `codegraph/AGENTS.md` | Vendored CodeGraph tool extension, timeout/retry behavior, and teaching layer tweaks. |
| `direnv/` | `direnv/AGENTS.md` | Vendored direnv extension sync notes and local lifecycle/status tweaks. |
| `fast/` | `fast/AGENTS.md` | Vendored fast-mode provider profile merge and session-only state rules. |
| `pi-lsp/` | `pi-lsp/AGENTS.md` | Vendored dreki LSP extension sync notes and local package-layout tweaks. |
| `smart-sessions/` | `smart-sessions/AGENTS.md` | Vendored session-summary behavior and model-role compatibility notes. |
| `subagent/` | `subagent/AGENTS.md` | Subagent runtime, tool surface, RPC, lifecycle, and local fork manifest. |
| `superpowers/` | `superpowers/AGENTS.md` | Vendored superpowers skill tree, overlay workflow, and sync script rules. |
| `tasks/` | `tasks/AGENTS.md` | Task DAG, process tracking, subagent bridge, and task-local fork manifest. |
