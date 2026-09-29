# lsp

Language Server Protocol extension for Pi. Registers one `lsp` tool plus `/lsp` status and `/lsp-restart` commands for diagnostics, hover, definitions, references, symbols, call hierarchy, and code actions.

## Upstream

- Source: https://github.com/dreki-gg/pi-extensions/tree/524efa3c9a28291a578d820c460c6637b200fb02/packages/lsp
- Package: `@dreki-gg/pi-lsp@0.4.1`
- NPM integrity: `sha512-urhY/MTG30p93eq/r748d3/OnCRy9Bc1YABi8pLQA/Cl51U9Ydlwqr8NRXlM7E7FWJnBj8OxGDptPQcUSieJ0A==`
- Last synced commit: `524efa3c9a28291a578d820c460c6637b200fb02`
- License: MIT; copyright 2026 Juan Albarran
- Provenance: runtime files copied from the pinned npm tarball `extensions/lsp/*`; repository LICENSE copied from the same commit because the tarball declares MIT but omits a license file.

## Entry Points

- `lsp` tool — diagnostics, hover, definitions, references, symbols, call hierarchy, and code actions.
- `/lsp` — show configured servers and their status; `/lsp-restart` — reset this session's server leases.

[index.ts](index.ts) and [tools.ts](tools.ts) register the full set of operations, commands, and hooks.

## Settings / Configuration

Current managed setup:

- Home Manager writes `~/.pi/agent/lsp.json` from `/home/zshen/personal/nix-config/modules/home-manager/features/ai-tools/common/lsp.nix`; that common module owns LSP server definitions, not extension loading.
- `install.sh` links `extensions/lsp/` into `~/.pi/agent/extensions/lsp`; do not add `lsp` to `settings.json` packages.
- Pi currently enables only the TypeScript pilot from the common module. OpenCode consumes the full LSP set from the same module.
- There is no repo-root `lsp.json`; do not create one.
- `.pi-lsp.json` is preserved non-dreki state. It is not the active dreki project override; use `.pi/lsp.json` for project-local dreki overrides.
- Claude Code and Codex LSP projections are future work only.

Dreki config search paths, low to high precedence:

- `~/.pi/agent/lsp.json` — Home Manager-generated Pi-agent LSP config.
- `.pi/lsp.json` — project-local overrides.

Config shape: `lsp` may be `false` or a server map; [config.ts](config.ts) defines server keys and loading.

Clients are shared process-wide only when the canonical workspace root and full resolved server configuration match.

## Local Tweaks

See `AGENTS.md` for the sync manifest. Current local changes include repo-local layout/provenance docs, managed `~/.pi/agent/lsp.json` config ownership, runtime fixes for diagnostics/process restart handling, extension loading via `install.sh`, and keeping `effect` as an extension workspace dependency instead of a root dependency.
