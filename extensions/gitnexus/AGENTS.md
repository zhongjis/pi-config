# gitnexus

## Overview

Vendored `pi-gitnexus` extension. Integrates with the external `gitnexus` CLI/MCP server to enrich tool results with knowledge-graph context and expose explicit GitNexus tools.

## Where to Look

| Task | Location | Notes |
|------|----------|-------|
| Extension wiring, hooks, slash command | `src/index.ts` | Main runtime behavior |
| Tool schemas and MCP calls | `src/tools.ts` | LLM-callable tools |
| Config, path safety, pattern parsing, augment command | `src/gitnexus.ts` | Most local safety logic |
| Stdio JSON-RPC client | `src/mcp-client.ts` | Long-lived `gitnexus mcp` subprocess |
| TUI menus | `src/ui/` | `/gitnexus` settings/status UI |
| Upstream workflow skills | `skills/` | Vendored for provenance/package parity |

## Always

- Keep upstream provenance in `README.md` and `package.json` `piVendor`.
- Do not add npm deps silently; current local port avoids upstream `cross-spawn`.
- Keep `gitnexus_rename` documentation warning: use `dry_run` first.
- Preserve path normalization/traversal guards in `src/tools.ts` and `src/gitnexus.ts`.

## Ask First

- Wiring vendored `skills/` into root/runtime skill loading. Root `skills` is Nix-managed.
- Adding package dependencies or changing root package metadata.
- Changing persistent config path `~/.pi/pi-gitnexus.json`.

## Local Tweaks

Intentional divergences from upstream. Preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Added root shim exporting `./src/index.js` | Panda harness discovers extension directories by root `index.ts` |
| `src/index.ts`, `src/mcp-client.ts`, `src/ui/main-menu.ts` | Replaced `cross-spawn` with Node `child_process.spawn` | Avoids adding a new root/package dependency |
| `src/index.ts` | Added `.js` suffixes to local imports and guards `pi.getFlag()` mock/runtime values | Matches repo ESM TypeScript import pattern; keeps smoke tests from treating flag definitions as strings |
| `src/ui/settings-menu.ts` | Replaced upstream `SettingsList` custom TUI with `ui.select` dialogs | Avoids adding `@mariozechner/pi-tui` to root deps and stays RPC-friendly |
| `package.json` | Removed upstream runtime `dependencies`; added `piVendor` metadata; changed `pi.extensions` to `./index.ts` | Preserve attribution while fitting local vendored layout without new deps |
| `README.md` | Replaced upstream marketing/install docs with repo-standard concise docs | Repo forbids `pi install npm:...` instructions and long marketing README |
| `skills/` | Kept upstream skills under extension root | Preserves upstream package payload; root skill wiring is Nix-managed here |
