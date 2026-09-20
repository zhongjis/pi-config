## Purpose

Provide the vendored session-recap extension.

## Ownership

- Owns recap lifecycle state, rendering, settings, model fallback, tests, and vendoring records.

## Local Contracts

- `index.ts` remains the auto-discovered default export.
- Model selection uses `recap.generate` through `tool_models.json`; `recap.model` is not supported.
- Configured candidates are tried in order with their thinking levels; an authenticated, deduplicated session model uses minimal reasoning last. Aborts do not fall through, and exhausted attempts emit one aggregate warning.
- Preserve upstream provenance in README and Apache-2.0 LICENSE. Record local deltas in README.

## Work Guidance

- Keep content, settings, model resolution, and lifecycle responsibilities separate.

## Verification

- `pnpm exec vitest run --project unit extensions/recap extensions/lib/test/tool-models.test.ts`

## Child DOX Index

- None.
