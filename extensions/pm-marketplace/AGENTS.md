## Purpose

Expose vendored product-management workflows only in Shen Nong mode.

## Ownership

- This parent owns runtime registration, resource gating, update checks, package metadata, and tests.
- The child owns pinned skill/command materials; persona content remains in [Shen Nong mode](../../modes/shennong/mode.md).

## Local Contracts

- Resource visibility and PM command execution MUST remain gated to the latest persisted `shennong` mode.
- Commands are discovered from plugin command directories, not a duplicated static catalog.
- Persona content MUST NOT be injected by this extension.
- Update checks MUST remain non-blocking, fail-silent, throttled to 24 hours, and bounded to five seconds.
- Syncs MUST keep package `piVendor.commit` aligned with child provenance.

## Work Guidance

- [README](README.md) owns runtime behavior and plugin overview.
- Vendoring SHOULD use the parent's installed vendoring skill router.
- You MUST preserve [upstream attribution](README.md#upstream) and the child's license/provenance.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/pm-marketplace/test/index.test.ts`.
- [Runtime tests](test/index.test.ts) cover mode gating, command behavior, and resource discovery.

## Child DOX Index

- [pm-skills](pm-skills/AGENTS.md) — pinned upstream skills, command workflows, omissions, and license.
- Everything outside that child remains owned here.
