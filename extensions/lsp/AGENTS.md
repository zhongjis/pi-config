## Purpose

Expose language-server queries through the unified `lsp` tool.

## Ownership

- Owns client/protocol handling, activation leases, status, and local tests.
- Home Manager owns managed server definitions; this extension owns loading and project overrides.

## Local Contracts

- Clients share only when canonical workspace root and full resolved configuration match.
- Restart/shutdown MUST release this activation's leases; only the final holder stops a shared server.
- Managed configuration is `~/.pi/agent/lsp.json`; project overrides use `.pi/lsp.json`.
- You MUST NOT recreate root `lsp.json` or treat `.pi-lsp.json` as the active override.
- Installation uses the extension directory link, not a settings package entry.

## Work Guidance

- [README configuration](README.md#settings--configuration) owns managed-config details and precedence.
- You MUST preserve [README Local Tweaks](README.md#local-tweaks), [provenance](README.md#upstream), and [LICENSE](LICENSE).
- Configuration changes MUST respect ownership outside this repository.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/lsp/test`.
- [Client pool](test/client-pool.test.ts), [lifecycle](test/lifecycle.test.ts), and [configuration](test/config.test.ts) cover sharing and ownership.

## Child DOX Index

- None; this document owns the entire subtree.
