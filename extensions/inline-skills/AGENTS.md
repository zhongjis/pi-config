# inline-skills

Vendored Pi extension: inline `/skill` autocomplete and per-turn skill loading.
Provenance (source URL, version, commit, license) lives in `README.md` `## Upstream`.

## Local Tweaks

Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Upstream `src/index.ts` vendored verbatim at repo root of the extension (not under `src/`) | Repo flat-tier layout: `extensions/<name>/index.ts`, no bare `.ts`, no nested `src/` for a single-file extension |
| `README.md` | Replaced upstream README (dropped install instructions, badges, screenshots) | Repo README spec: concise, factual, no `pi install npm:` guidance |
| (omitted) | Upstream `package.json`, `tsconfig.json`, `CHANGELOG.md`, `assets/` not vendored | Flat-tier extension; deps are `catalog:` Pi built-ins, no local package/toolchain |

## Sync notes

- Upstream is a monorepo package `packages/pi-inline-skills`. Read its `CHANGELOG.md` before syncing.
- No `1.0.5` git tag was pushed upstream; pin to a master commit SHA that contains the target version.
- Imports use `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui` (root `catalog:`). Bump the catalog, not a local manifest.
- On sync, re-verify these exports exist in the installed Pi: `CustomEditor`, `SkillInvocationMessageComponent`, `ParsedSkillBlock`, `ExtensionAPI.addAutocompleteProvider`, `registerMessageRenderer`, `appendEntry`.

## Test-infra dependencies

Root smoke discovery (`test/extensions.smoke.test.ts`) loads this extension and fires `session_start`, which needs:

- `test/fixtures/mock-context.ts`: `ui.addAutocompleteProvider` (no-op).
- `test/stubs/pi-coding-agent.ts`: `SkillInvocationMessageComponent` class stub.

Keep both when syncing; removing them breaks this extension's smoke case.
