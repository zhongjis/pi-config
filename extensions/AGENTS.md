# extensions

## Overview
Runtime Pi extensions. All extensions live in directories with `index.ts` entrypoints. No bare `.ts` files at the top level.

## Structure
```
extensions/
├── <name>/              # each extension in its own directory
│   ├── index.ts         # entrypoint (required)
│   └── README.md        # documentation (required, see docs/specs/extensions.md)
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
| Subagents | `subagents/AGENTS.md` | Vendored live package with a high-coupling runtime/event surface |
| Tasks | `tasks/AGENTS.md` | File-backed DAG + process tracking + planning cleanup RPC |
| Agent modes | `modes/src/commands.ts`, `modes/src/hooks.ts`, `modes/src/mode-state.ts` | Mode-owned resource transitions submit through command context; reload is terminal. |
| Scoped built-in bash guard | `smart-tool-guards/`, `lib/guard-registration.ts`, `lib/tool-models.ts` | Fu Xi and protected read-only subagents opt into fail-closed guarding; deferred commands use `smart-tool-guards.classifier`. |
| Consolidated QoL/UI | `qol/` | Structured simple extension owning header, footer, post-settle over-limit compaction, prompt URL widget, session/exit commands, and `write` rendering. |
| Web research tools | `pi-web-access` git package (`settings.json`) | Vendored remote, not a local `extensions/` dir |
| Provider failover | `clauderock/` | Anthropic → AWS Bedrock fallback on quota/rate-limit; uses `lib/stream-fallback.ts` |
| Shared model roles | `lib/tool-models.ts`, `docs/specs/extension-model-usage.md` | `tool_models.json` role schema; `guard.tool` backs `smart-tool-guards.classifier`. |
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
- Pi package versions (`@earendil-works/pi-*`) + `typebox` are centralized in root `pnpm-workspace.yaml` `catalog:`; workspace manifests reference `catalog:`. Bump the catalog, not individual manifests.
- Follow `CONVENTIONS.md` exactly for events:
  - `user-prompted` once before first blocking tool UI prompt
  - `awaitingUserAction.suppressContinuationReminder` for persisted waiting state
  - `<namespace>:<event>` for lifecycle broadcasts
  - `<namespace>:rpc:<method>` + `:reply:${requestId}` for RPC
- If a new extension needs special smoke handling, update `test/extensions.smoke.test.ts`.
- Every locally registered tool needs width-safe `renderCall`/`renderResult` components, a maximum three rendered collapsed rows (except identity-preserved native streaming delegates), configured `keyHint("app.tools.expand", ...)` hints, unchanged model-facing content, and registered-definition coverage using Pi TUI visible-width APIs.

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
| `caveman/` | `caveman/AGENTS.md` | Caveman prompt injection, upstream skill sync notes, and local Pi behavior divergences. |
| `codegraph/` | `codegraph/AGENTS.md` | Vendored CodeGraph tool extension, timeout/retry behavior, and teaching layer tweaks. |
| `direnv/` | `direnv/AGENTS.md` | Vendored direnv extension sync notes and local lifecycle/status tweaks. |
| `fast/` | `fast/AGENTS.md` | Vendored fast-mode provider profile merge and session-only state rules. |
| `goal/` | `goal/AGENTS.md` | Vendored rich Codex-style goal extension (oh-my-openagent `packages/pi-goal`): blocked/budget statuses, `@mariozechner`→`@earendil-works` scope + `bun:test`→`vitest` migrations, and shared mock-context fixture dependency. |
| `init/` | `init/AGENTS.md` | AGENTS.md/DOX initialization command extension, `/init-deep` preservation, and template layout. |
| `inline-skills/` | `inline-skills/AGENTS.md` | Vendored inline `/skill` autocomplete + per-turn skill loading; provenance and test-infra shim notes. |
| `lsp/` | `lsp/AGENTS.md` | Vendored dreki LSP extension sync notes and local package-layout tweaks. |
| `pm-marketplace/` | `pm-marketplace/AGENTS.md` | Pi-native PM skill pack + /pm:* command registry gated to the 神農 shennong mode; provenance + update-check. |
| `queue-steer/` | `queue-steer/AGENTS.md` | Visible steering/follow-up queues, editable timeline, and local sync notes. |
| `smart-sessions/` | `smart-sessions/AGENTS.md` | Vendored session-summary behavior and model-role compatibility notes. |
| `thinking-steps/` | `thinking-steps/AGENTS.md` | Thinking Steps renderer sync notes, TUI-only lifecycle ownership, and native renderer compatibility. |
| `subagents/` | `subagents/AGENTS.md` | Vendored live subagent runtime, tool surface, RPC, lifecycle, provenance, and local fork manifest. |
| `tasks/` | `tasks/AGENTS.md` | Task DAG, process tracking, planning cleanup, and task-local fork manifest. |
