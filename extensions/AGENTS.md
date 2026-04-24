# extensions

## Overview
Runtime Pi extensions. Mixed shapes: single-file entrypoints, flat directories, and `index.ts` → `src/index.ts` packages.

## Structure
```
extensions/
├── *.ts                 # simple one-file extensions
├── CONVENTIONS.md       # repo-wide event bus contract
├── subagent/            # background-agent runtime + widget + RPC
├── tasks/               # task DAG, widget, process/subagent bridge
├── pi-web-access/       # web search, fetch, curator, GitHub/video handling
├── modes/               # plan/approval orchestration package
└── */test/              # unit tests for structured extensions
```

## Where to Look
| Task | Location | Notes |
|------|----------|-------|
| Add simple extension | `extensions/foo.ts` | Small, self-contained only |
| Add multi-file extension | `extensions/foo/index.ts` + siblings | Flat directory tier |
| Add complex extension | `extensions/foo/index.ts` + `src/` + `test/` | Re-export-only `index.ts` |
| Shared event semantics | `CONVENTIONS.md` | Source of truth for `pi.events` usage |
| Subagents | `subagent/AGENTS.md` | High-coupling runtime/event surface |
| Tasks | `tasks/AGENTS.md` | File-backed task store + RPC bridge |
| Web research tools | `pi-web-access/AGENTS.md` | Providers, curator, GitHub/video fallbacks |

## Commands
```bash
pnpm test:extensions
pnpm lint:typecheck
```

## Always
- Entrypoint shape: `extensions/foo.ts` or `extensions/foo/index.ts` only.
- Promote layout gradually: bare file → flat directory → `src/` package. Do not skip straight to deep nesting.
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
