# context-management

Vendored Pi context management extension. Preserve upstream behavior unless the Local Tweaks table says otherwise.

## Upstreams

- `pi-context`: `https://github.com/ttttmr/pi-context`, version `1.1.3`, commit `1d8bcf280f9c7ea0ee24249cacc9538eaee71a52`, MIT.
- `pi-context-prune`: `https://github.com/championswimmer/pi-context-prune`, version `0.6.3`, commit `fa793225d9bb355c8df9984fe131cfe74eabee6b`, MIT.

## Local Tweaks

Intentional divergences from upstream. Preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Local shim re-exports `./src/index.js` | Repo smoke/install discovers `extensions/<name>/index.ts` |
| `src/index.ts` | Composes pi-context core, local dashboard, and pi-context-prune registrations | User requested one combined extension under `extensions/context-management` |
| `src/context-core.ts` | Adapted from `pi-context/src/index.ts`; default export renamed to `registerContextCore`; Typebox import uses `typebox` | Allows composition and avoids adding a root `@sinclair/typebox` dependency |
| `src/context-dashboard.ts` | Preserved old local `extensions/context/index.ts`; export renamed to `registerContextDashboard` | Existing local `/context` dashboard was richer than upstream and already vendored from pi-context |
| `src/context-prune.ts` | Adapted from `pi-context-prune/index.ts`; default export renamed to `registerContextPrune`; imports flattened from `./src/*` to `./*` | Keeps repo max depth at `extensions/foo/src/` and allows composition |
| `src/query-tool.ts`, `src/context-prune-tool.ts` | Typebox import uses `typebox` | Avoids adding a root `@sinclair/typebox` dependency |
| `skills/context-management/SKILL.md` | Copied from `pi-context` | Provides the requested context-management skill docs |
| `prompts/release.md` | Copied from `pi-context-prune` | Preserves upstream prompt package metadata |
| `package.json` | Local package metadata with both upstream sources and Pi extension/skill/prompt entries | Preserves provenance and package discovery hints without a nested toolchain |
| `README.md` | Rewritten to repo README format | Keeps docs concise and attribution clear |
| `extensions/context/` | Removed | Replaced by this combined extension; prevents duplicate `/context` registration |

## Validation

Run from repo root:

```bash
pnpm test:extensions
pnpm lint:typecheck
```
