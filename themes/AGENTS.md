## Purpose

Local Pi theme assets.

## Ownership

- [github-diff.json](github-diff.json) is the sole theme asset.
- This document owns the entire themes directory.
- [../install.sh](../install.sh) owns individual repo `*.json` links inside the real `~/.pi/agent/themes/` directory; Home Manager owns `stylix.json`.

## Local Contracts

- You MUST preserve the asset's Pi theme JSON structure.

## Work Guidance

## Verification

- `pnpm exec vitest run --project unit test/install-themes.test.ts` exercises installation in a temporary repo and HOME without dependency installs.

## Child DOX Index

- None; this document owns the asset and remaining files here.
