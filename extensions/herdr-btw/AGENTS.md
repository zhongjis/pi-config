## Purpose

Vendored `/btw` extension: open a tool-enabled Pi side thread in a focused Herdr pane
without changing the parent transcript, with an optional merge back into the parent.

## Ownership

- Owns the `/btw` command grammar, parent/child launch coordination, context snapshot
  payloads, config store, and the merge mailbox protocol.
- The external `herdr` CLI owns pane/agent lifecycle; this extension only invokes it.

## Local Contracts

- `index.ts` and `src/**` track upstream verbatim; behavior and public `/btw` surface
  MUST be preserved across syncs.
- [LICENSE](LICENSE) and the [README Upstream record](README.md#upstream) MUST be kept
  accurate when syncing.
- The merge mailbox uses temp-dir request/ack files, not `pi.events` RPC; keep that
  transport when adapting.

## Work Guidance

- Vendoring/sync work MUST use [pi-extension-vendoring](../../.agents/skills/pi-extension-vendoring/SKILL.md).
- Pin the upstream commit and update the README Upstream record on every sync.
- Preserve upstream `.ts` import specifiers; do not reformat vendored source.

## Local Tweaks

- `index.ts`, `src/config.ts`, and `src/core.ts` carry a **LOCAL PATCH** (no longer verbatim): a `closeOnExit`
  config flag (default `false`) that auto-closes the child pane on quit, and `PAYLOAD_VERSION` bumped 4→5 for
  the new config field. Re-apply on upstream sync.
- Vendored verbatim (unmodified): `src/context-store.ts`, `src/merge.ts`, `src/router.ts`, `LICENSE`.
- Not vendored: `package.json`, `package-lock.json`, `.gitignore`, and the upstream `test/` suite
  (`node:test` via `tsx --test`). This repo relies on root tooling and runs extension tests under
  Vitest with `@earendil-works/*` aliased to stubs.
- Local Vitest tests added (`test/config.test.ts`, `test/shutdown.test.ts`) — this diverges from the
  prior note that no local test coverage was vendored; tests cover `closeOnExit` config parsing,
  `isBtwPayload` validation, and auto-close shutdown behavior.
- Portable default: repo-root `pi-herdr-btw.json` (autoSubmit+closeOnExit ON) is symlinked to
  `~/.pi/agent/pi-herdr-btw.json` by `install.sh` (added to `ALLOWED_ITEMS`).
- `tsconfig.json` kept from upstream with the `test/**` include removed.

## Verification

- Focused typecheck: `pnpm exec tsc --noEmit -p extensions/herdr-btw/tsconfig.json`
  (resolves `@earendil-works/*` against installed packages).

## Child DOX Index

- None; this document owns the entire subtree.
