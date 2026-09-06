## Purpose

Keep the pinned upstream PM skills and command workflows usable as Pi resources.

## Ownership

- Owns all vendored plugin skill/command materials, provenance, and upstream license.
- [Parent runtime](../AGENTS.md) owns mode gating, command registration, and update checks.

## Local Contracts

- [PROVENANCE.md](PROVENANCE.md) is authoritative for the pinned commit, included plugins, and intentional omissions.
- You MUST preserve [LICENSE](LICENSE) and upstream attribution.
- Skill and command directories remain separate inputs to resource discovery and command registration.
- You MUST NOT restore omitted plugins or Claude Code manifests during routine syncs.
- Provenance and [package metadata](../package.json) MUST agree on the pinned commit.

## Work Guidance

- Syncs MUST follow [provenance updating guidance](PROVENANCE.md#updating), including collision and frontmatter auditing.
- Vendoring SHOULD use the installed [pi-extension-vendoring skill](../../../.agents/skills/pi-extension-vendoring/SKILL.md).
- Plugin catalogs belong in provenance and the [parent README](../README.md), not this contract.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/pm-marketplace/test/index.test.ts` checks runtime consumption.
- No separate child test runner exists.

## Child DOX Index

- None; this document owns every included plugin subtree and the loose provenance/license files.
