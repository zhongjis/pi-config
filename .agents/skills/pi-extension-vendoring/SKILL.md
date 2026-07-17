---
name: pi-extension-vendoring
description: |
  Vendor or sync third-party Pi extensions into this repo's directory-only `extensions/<name>/` layout. Use when importing from a git host, npm package, or local clone; updating, re-vendoring, or reviewing releases for an existing upstream copy; or adapting vendored code to local contracts. Preserve provenance and `## Local Tweaks`, gate dependency and compatibility risks, and validate before completion.
---

# Pi Extension Vendoring

Vendoring is three-way maintenance: preserve upstream intent, preserve intentional local drift, apply smallest safe adaptation.

## Context pointers

- Read `.agents/skills/pi-extensions/references/local-tweaks-format.md` when creating, reconstructing, or updating `## Local Tweaks`.
- Read `references/sync-flow.md` before comparing or merging an existing upstream copy.

## Route

Choose operation mode, then authorization scope.

Operation mode:

- **First-time vendoring** — target absent.
- **Existing sync** — target exists; user asks update, sync, refresh, re-vendor, upgrade, release review, or merge.
- **Local-only adaptation** — upstream unchanged; local behavior, layout, docs, or tests change.

Authorization scope:

- **Planning / release-review** — no edits. Name operation mode, inspect only authorized sources, deliver plan + risk memo, stop.
- **Implementation** — edit only when user asks to vendor, import, implement, sync, or adapt. Existing sync waits for its pre-source-edit gate.

Ask one precise question when target, upstream, mode, or authorization remains ambiguous after inspection.

## First reads

Before code edits: `AGENTS.md`, `extensions/AGENTS.md`, `extensions/CONVENTIONS.md`, plus relevant child `AGENTS.md`.

Existing sync reads, before upstream code: target `AGENTS.md` + `## Local Tweaks`, README `## Upstream`, optional package.json, and index.ts.

This repo vendors locally. Never recommend `pi install npm:...`.

## Intake and layout

Record mode/scope, upstream source/ref, user goal, stable public surface, dependency/toolchain needs, and required checks.

Target is always `extensions/<name>/`, never `extensions/<name>.ts`. Every target has index.ts and README. Choose smallest tier:

- **Flat** — index.ts plus same-level helpers.
- **Structured** — index.ts shim, implementation under src, optional tests under test.
- **Package** — local package.json only when upstream needs it and nested toolchain risk is approved.

Never nest deeper than src. Never move tiers when smaller tier fits without approval.

## Risk memo

```markdown
## Vendoring risk memo
- Operation mode: <first-time | existing sync | local-only adaptation>
- Authorization scope: <planning/release-review | implementation>
- Source: <url/path/package>, <tag/version/commit or none>
- Local target: extensions/<name>/
- Layout: <flat | structured | package>
- Public surface changes: <none | list>
- Local tweaks/provenance: <status>
- Compatibility: <events/RPC/UI; state/config; auth/network; dependencies; tests>
- Warning gates needing approval: <none | list>
- Planned validation: <commands/checks>
```

Any warning means stop after memo until approved.

## Warning gates

Approval required before shared event/RPC/payload changes; new dependency; nested package/toolchain; avoidable tier move; new auth/secrets/background network/telemetry/storage; or root scripts/config, TypeScript config, smoke discovery, provider order, default workflow, config keys, response shape changes.

## Dependency and provenance

Low risk means Node built-ins or packages already present in root package.json, workspace catalog, or repeated local extension patterns. Everything else is new: report package/version, upstream need, existing-API alternative, visible license/security/maintenance concern, exact metadata change, and provenance impact; then stop.

Review upstream scopes/imports requiring adaptation. Preserve every available author, license, repository/homepage, version/tag, commit SHA, and last-synced version. Flattening metadata must not hide attribution.

## Compatibility

Before copying/changing code, inspect entrypoint/export; registrations and schemas; imports/deps/scripts; blocking UI/events; RPC/storage/config/auth/filesystem/network surfaces; metadata; tests.

Local contracts: `user-prompted` once before blocking tool UI; persisted waits use `awaitingUserAction.suppressContinuationReminder`; RPC uses requestId-scoped reply channels and success/error envelope; lifecycle events use `<namespace>:<event>`.

## Branch gates

### Planning / release-review

Done only when output states operation mode + scope, source/provenance target, layout, public-surface risk, warning gates, dependency assessment, manifest/README needs, and validation plan. No edits.

Dry-run blueprint also names proposed artifacts, maps every available provenance field, gives exact focused/broad checks with binary pass criteria, and says none ran.

### First-time pre-edit

Before edits: target absent and normalized; upstream inspected natively; immutable identity and available provenance captured; compatibility complete; tier chosen; memo delivered; warnings approved or absent.

Then adapt surgically. Preserve behavior/attribution; create concise README; create `## Local Tweaks` only for intentional divergence; add focused tests where nearby pattern or risk justifies.

### Existing sync pre-source-edit

Follow `references/sync-flow.md`. Record dirty state; read manifest/provenance first; inspect release notes or state fallback; pin immutable upstream commit; classify differences; resolve unknowns; deliver memo; obtain approvals.

Missing/stale manifest is a hard stop: reconstruct from git history, README/CHANGELOG, and documented upstream-base comparison; write/fix before source edits; present it; ask user to confirm. Until confirmed, outcome is blocked, never successful sync.

### Local-only adaptation

Confirm upstream unchanged. Read current README, AGENTS, affected source. Keep provenance unless inaccurate. Update Local Tweaks for divergence. Apply smallest local edit; no upstream fetch/merge unless mode changes.

### Universal completion

Complete only when all pass:

- Required index.ts + README exist; README Upstream current; available provenance represented.
- Every Local Tweaks row preserved/updated, or retired with approval.
- Stable public surfaces verified.
- No unapproved dependency/toolchain/layout/root/provider/default/config/response change.
- Focused and relevant broad validation pass; pre-existing dirty changes intact.
- Readback confirms files/links; final report gives exact results and blockers.

Failed, skipped, or unavailable required checks mean incomplete/blocked, never success.

## README and Local Tweaks

Every README is concise, factual, about 120 lines max. Include applicable summary, Upstream, Tools, Commands, Hooks, Settings, Events, Local Additions. Upstream records source URL, synced version/tag, immutable SHA, license, local adaptation summary. Remove install/marketing/badges/screenshots/quickstarts/future-work/audit-test-file tables/developer guides.

Intentional divergence requires target AGENTS.md `## Local Tweaks`: current state, not history. Use authoritative format pointer above.

## Validation

Run narrow checks first, then relevant broad checks:

```bash
pnpm --dir extensions/<name> test   # when package tests exist
pnpm exec vitest run --project unit extensions/<name>/**/*.test.ts
pnpm test:extensions
pnpm lint:typecheck
```

Manually exercise changed registrations, schemas, safe inputs/mocks, storage lookup, and auth/network opt-in where runnable. Call broad failure unrelated only after proving failing files untouched.

Instruction-only skill edits: re-read changed files, resolve links, parse eval JSON, search stale/dead-doc terms.

Major skill changes: compare updated skill with prior snapshot on representative evals, grade expectations, aggregate, generate eval-viewer review.

## Output

Report mode/scope, files changed, upstream identity, README provenance, Local Tweaks disposition, dependency approvals, risk gates, exact validation results, remaining blockers.
