# lsp

Language Server Protocol extension for Pi. Registers one `lsp` tool plus `/lsp` status and `/lsp-restart` commands for diagnostics, hover, definitions, references, symbols, call hierarchy, and code actions.

## Upstream

- Source: https://github.com/dreki-gg/pi-extensions/tree/524efa3c9a28291a578d820c460c6637b200fb02/packages/lsp
- Package: `@dreki-gg/pi-lsp@0.4.1`
- NPM integrity: `sha512-urhY/MTG30p93eq/r748d3/OnCRy9Bc1YABi8pLQA/Cl51U9Ydlwqr8NRXlM7E7FWJnBj8OxGDptPQcUSieJ0A==`
- Last synced commit: `524efa3c9a28291a578d820c460c6637b200fb02`
- License: MIT; copyright 2026 Juan Albarran
- Provenance: runtime files copied from the pinned npm tarball `extensions/lsp/*`; repository LICENSE copied from the same commit because the tarball declares MIT but omits a license file.

## Tools

### `lsp`

Unified LSP tool. Parameters: `operation`, optional `filePath`, `line`, `character`, `query`.
Operations: `diagnostics`, `hover`, `goToDefinition`, `findReferences`, `goToImplementation`, `documentSymbol`, `workspaceSymbol`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`, `codeActions`.

## Commands

- `/lsp` — Show configured servers and lazy/running status.
- `/lsp-restart` — Reset this session's leases; servers shared with other sessions remain running until the final activation releases them.

## Hooks

- `session_start` — Release prior activation leases, scaffold a starter managed config at `~/.pi/agent/lsp.json` if no managed or project config exists, load config, and set status.
- `tool_execution_end` — Refresh status after `lsp` tool calls.
- `session_shutdown` — Release this activation's leases; the final holder stops shared language-server processes.

## Settings / Configuration

Current managed setup:

- Home Manager writes `~/.pi/agent/lsp.json` from `/home/zshen/personal/nix-config/modules/home-manager/features/ai-tools/common/lsp.nix`; that common module owns LSP server definitions, not extension loading.
- `install.sh` links `extensions/lsp/` into `~/.pi/agent/extensions/lsp`; do not add `lsp` to `settings.json` packages.
- Pi currently enables only the TypeScript pilot from the common module. OpenCode consumes the full LSP set from the same module.
- Repo root `lsp.json` was removed; do not recreate it.
- `.pi-lsp.json` is preserved non-dreki state. It is not the active dreki project override; use `.pi/lsp.json` for project-local dreki overrides.
- Claude Code and Codex LSP projections are future work only.

Dreki config search paths, low to high precedence:

- `~/.pi/agent/lsp.json` — Home Manager-generated Pi-agent LSP config.
- `.pi/lsp.json` — project-local overrides.
Config shape: `lsp` may be `false` or a server map. Each server supports `command`, `extensions`, `disabled`, `env`, and `initialization`.

Clients are shared process-wide only when the canonical workspace root and full resolved server configuration match.

## Local Tweaks

See `AGENTS.md` for the sync manifest. Current local changes include repo-local layout/provenance docs, managed `~/.pi/agent/lsp.json` config ownership, runtime fixes for diagnostics/process restart handling, extension loading via `install.sh`, and keeping `effect` as an extension workspace dependency instead of a root dependency.
