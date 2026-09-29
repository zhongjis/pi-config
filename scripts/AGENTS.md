## Purpose

Repository maintenance, validation, and runtime package-command helpers.

## Ownership

- This document owns every script in this directory.
- [../package.json](../package.json) owns root command entrypoints.
- [lint-typecheck.mjs](lint-typecheck.mjs) coordinates root and package checks.
- [pi-package-npm.sh](pi-package-npm.sh) selects ephemeral build tools and package managers.

## Local Contracts

- You MUST preserve command arguments and exit failures across wrappers.

## Work Guidance

- You SHOULD use fixture-driven tests for wrapper changes.

## Verification

- Package wrapper: `pnpm exec vitest run --project unit test/pi-package-npm.test.ts`.
- Aggregate checks: `pnpm lint:typecheck`.

## Child DOX Index

- None; this document owns all scripts and remaining files here.
