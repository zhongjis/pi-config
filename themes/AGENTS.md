## Purpose

Local Pi theme assets.

## Ownership

- [github-diff.json](github-diff.json) is the sole theme asset.
- This document owns the entire themes directory.
- [../install.sh](../install.sh) owns individual repo `*.json` links inside the real `~/.pi/agent/themes/` directory; Home Manager owns `stylix.json`.

## Local Contracts

- The asset names the theme `github-diff`.
- Its `$schema` points to the Pi theme schema.
- `appearance` declares the dark background the palette targets.
- `vars` holds reusable colors; `colors` assigns presentation roles.
- `export` contains exported-page background colors.
- You MUST preserve the asset's Pi theme JSON structure.
- Installation preserves real directories and unrelated entries, including Home Manager links. It replaces only the exact directory symlink to this repo's `themes/`; unknown directory symlinks and non-directory destinations are refused.
- Correct per-file links are idempotent; absent destinations are linked. Existing conflicts, including dangling symlinks, are refused without overwrite.
- Keep `themes` allowlisted and handle it before generic directory replacement in the installer.

## Work Guidance

## Verification

- `pnpm exec vitest run --project unit test/install-themes.test.ts` exercises installation in a temporary repo and HOME without dependency installs.

## Child DOX Index

- None; this document owns the asset and remaining files here.
