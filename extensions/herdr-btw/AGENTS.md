## Purpose

Vendored `/btw` extension: open a tool-enabled Pi side thread in a focused Herdr pane
without changing the parent transcript, with an optional merge back into the parent.

## Ownership

- Owns the `/btw` command grammar, parent/child launch coordination, context snapshot
  payloads, config store, and the merge mailbox protocol.
- The external `herdr` CLI owns pane/agent lifecycle; this extension only invokes it.

## Local Contracts

- `index.ts` and `src/**` track upstream except the [Local Tweaks](#local-tweaks) patch; behavior
  and public `/btw` surface MUST be preserved across syncs.
- [LICENSE](LICENSE) and the [README Upstream record](README.md#upstream) MUST be kept
  accurate when syncing.
- The merge mailbox uses temp-dir request/ack files, not `pi.events` RPC; keep that
  transport when adapting.

## Work Guidance

- Pin the upstream commit and update the README Upstream record on every sync.
- Preserve upstream `.ts` import specifiers; do not reformat vendored source.

## Local Tweaks

Current divergences from upstream; re-apply each on upstream sync:

- **Patched:** `index.ts`, `src/config.ts`, and `src/core.ts` add a `closeOnExit` config flag (default `false`)
  that auto-closes the child pane on quit, and set `PAYLOAD_VERSION` to 5 for that config field.
- **Patched:** `index.ts` runs the child-side quit cleanup (payload removal, pane close) only in TUI sessions, so UI-less subagent children of a side-thread process leave the pane and payload alone.
- **Vendored verbatim:** `src/context-store.ts`, `src/merge.ts`, `src/router.ts`, `LICENSE`.
- **Kept with changes:** `tsconfig.json`, with the `test/**` include removed.
- **Not vendored:** `package.json`, `package-lock.json`, `.gitignore`, and the upstream `test/` suite
  (`node:test` via `tsx --test`). This repo relies on root tooling and runs extension tests under
  Vitest with `@earendil-works/*` aliased to stubs.
- **Local tests:** [test/config.test.ts](test/config.test.ts) and [test/shutdown.test.ts](test/shutdown.test.ts)
  cover `closeOnExit` config parsing, `isBtwPayload` validation, and auto-close shutdown behavior.
- **Portable default:** repo-root `pi-herdr-btw.json` (autoSubmit and closeOnExit on) is symlinked to
  `~/.pi/agent/pi-herdr-btw.json` by `install.sh`.

## Verification

- Focused typecheck: `pnpm exec tsc --noEmit -p extensions/herdr-btw/tsconfig.json`
  (resolves `@earendil-works/*` against installed packages).

## Child DOX Index

- None; this document owns the entire subtree.
