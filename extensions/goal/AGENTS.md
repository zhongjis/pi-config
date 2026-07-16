# pi-goal

Vendored from `code-yeongyu/oh-my-openagent` monorepo path `packages/pi-goal` (branch `dev`), the richer Codex-style goal variant (blocked status, token budgets, Codex footer). Upstream package `@oh-my-opencode/pi-goal` v4.15.1.

## Local Tweaks

Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `src/index.ts`, `src/goal/ui.ts` | Migrated pi peer imports `@mariozechner/*` → `@earendil-works/*` | This repo's runtime + catalog use the `@earendil-works` scope (0.79.0); `@mariozechner` is not installed |
| `test/*.ts` | Migrated test framework `bun:test` → `vitest` | Repo runs vitest; upstream used `bun test` |
| `test/extension.test.ts` | `setSystemTime()` → `vi.useFakeTimers({ toFake: ["Date"] })` + `vi.setSystemTime()` / `vi.useRealTimers()` | Bun's clock API has no vitest equivalent; fake only `Date` to avoid faking real timers |
| `index.ts` | Local-only root re-export of `./src/index.js` | Repo discovers extensions at `extensions/<name>/index.ts`; upstream entry is `src/index.ts` |
| (omitted files) | Did not vendor upstream `package.json`, `tsconfig.json`, `biome.json`, `.github/`, `scripts/`, `SKILL.md` | Root catalog provides `@earendil-works/pi-*` + `typebox`; root tooling (biome/tsc/vitest) already covers this extension; skills are Nix-managed, not symlinked per-extension |
| `src/index.ts`, `test/store.test.ts`, `test/extension.test.ts`, `README.md` | Goal-state storage path segment `extensions/pi-goal` → `extensions/goal` | User objective renamed the extension path to `extensions/goal`; state now persists under `<sessionDir>/extensions/goal/`. Diverges from upstream (`pi-goal`); re-apply on sync. Message-type ids (`pi-goal-continuation`, `pi-goal-budget-limit`) and the package name are left unchanged (not paths) |
| `src/goal/render.ts` (local-only file), `src/index.ts` | Added `renderCall`/`renderResult` to the three goal tools for compact TUI presentation (collapsed `keyword: content` summary; expanded = raw `result.content`) | Not in upstream; per the `pi-tool-output-presentation` skill. `result.content` (model-visible) is unchanged. Re-apply on sync: keep `render.ts` and re-add the two renderer props to each `pi.registerTool(...)` in `src/index.ts` |
| `src/goal/ui.ts` | `updateGoalUi` publishes the current goal indicator on the `Symbol.for("pi-goal:footer")` global bridge (`{ getIndicator() }`) and skips installing its own footer when the `visuals` extension owns the footer slot (`Symbol.for("pi-visuals:footer")`) | Only one `ctx.ui.setFooter()` slot exists; upstream's unconditional `setFooter` clobbered this repo's `visuals` footer when a goal was set/cleared. Now `visuals` renders the goal indicator from the bridge (on footer line 3, to the left of the LSP/infra group); the standalone Codex footer is kept as the fallback when `visuals` is absent. Diverges from upstream; re-apply on sync |
| `test/footer-bridge.test.ts` | New repo-local test (not vendored) covering the `visuals` footer-bridge integration above | Verifies `updateGoalUi` defers to `visuals` (installs no footer) when `Symbol.for("pi-visuals:footer")` is set, publishes the indicator on `Symbol.for("pi-goal:footer")`, and falls back to its own footer otherwise. Keep on sync |

## Sync Notes

- Upstream source: `https://github.com/code-yeongyu/oh-my-openagent`, path `packages/pi-goal`, branch `dev`.
- Last synced upstream version: `4.15.1`.
- Last synced upstream commit: `dec381ed201a1326883db9f42bdb3c2add91b299`.
- Upstream license: MIT (`LICENSE` vendored).
- Runtime deps present via root catalog: `typebox`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`.
- On re-sync, re-apply the scope migration, the bun→vitest test migration, the `extensions/pi-goal`→`extensions/goal` storage-path rename, and the `visuals` footer-bridge integration in `src/goal/ui.ts` above, then run the root `unit` vitest project.
- Statuses in this variant: `active`, `paused`, `blocked`, `budgetLimited`, `complete` (richer than the standalone `code-yeongyu/pi-goal` main branch, which is budget-free).

## Runtime + fixture dependencies

- `src/goal/ui.ts` imports value helpers `truncateToWidth`, `visibleWidth` from `@earendil-works/pi-tui` (a pi built-in; other repo extensions import it the same way). Static LSP/tsc may report "cannot find module `@earendil-works/pi-tui`" because it is not a top-level `node_modules` package — this is a pre-existing repo-wide artifact; runtime (live pi) and vitest (stub alias) both resolve it.
- `src/index.ts` `session_start` calls `ctx.sessionManager.getSessionDir()`, `ctx.isIdle()`, and `ctx.hasPendingMessages()`. These were added to `test/fixtures/mock-context.ts` so the centralized smoke test (`test/extensions.smoke.test.ts`) can load this extension. Preserve them on re-sync.
