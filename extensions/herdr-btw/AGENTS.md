## Purpose

Vendored `/btw` extension: open a tool-enabled Pi side thread in a focused Herdr pane
without changing the parent transcript, with an optional merge back into the parent.

## Ownership

- Owns the `/btw` command grammar, parent/child launch coordination, context snapshot
  payloads, config store, and the merge mailbox protocol.
- The external `herdr` CLI owns pane/agent lifecycle; this extension only invokes it.

## Local Contracts

- `index.ts` and `src/**` track upstream except the [Local Tweaks](README.md#local-tweaks) patch; behavior
  and public `/btw` surface MUST be preserved across syncs.
- [LICENSE](LICENSE) and the [README Upstream record](README.md#upstream) MUST be kept
  accurate when syncing.
- The merge mailbox uses temp-dir request/ack files, not `pi.events` RPC; keep that
  transport when adapting.

## Work Guidance

- On upstream sync, you MUST re-apply every divergence in the [README Local Tweaks checklist](README.md#local-tweaks).
- Pin the upstream commit and update the README Upstream record on every sync.
- Preserve upstream `.ts` import specifiers; do not reformat vendored source.

## Verification

- Focused typecheck: `pnpm exec tsc --noEmit -p extensions/herdr-btw/tsconfig.json`
  (resolves `@earendil-works/*` against installed packages).
- Focused units: `pnpm exec vitest run --project unit extensions/herdr-btw/test`.
- Installed inference-free probe: `node extensions/herdr-btw/test/installed-inherit-probe.mjs <pi-1.0.0-package-launcher> [web-tool-activation.ts]`; uses private settings/PTY, explicit fixture extensions, and the installed web loader without network/model requests. Bypass personal credential-loading launch wrappers.

## Child DOX Index

- None; this document owns the entire subtree.
