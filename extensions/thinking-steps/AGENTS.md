# thinking-steps

Vendored extension. Renders assistant thinking blocks in three modes by monkey-patching Pi's interactive `AssistantMessageComponent`. Upstream source/version live in `README.md` → `## Upstream`.

## How it works (load-bearing)

The extension patches the prototype of the runtime's `AssistantMessageComponent` (`updateContent` / `setHideThinkingBlock` / `setHiddenThinkingLabel`) so thinking content renders as a `ThinkingStepsComponent`. This relies on Pi's extension loader (jiti/virtual-module aliases) routing a bare `import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent"` to the **live runtime module** — patching the same class instances the TUI renders with. It is inherently coupled to Pi internals and can re-break on any Pi internal restructure.

## Local Tweaks

Intentional divergences from upstream v1.0.11. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `internal-patch.ts` | Bare-import `AssistantMessageComponent` from `@earendil-works/pi-coding-agent` instead of `import.meta.resolve` + `dist/modes/...` filesystem import | Pi 0.80.x is a Bun binary; the old path-based resolve landed on a stale bundled `@mariozechner@0.69.0` copy the TUI never uses (silent no-op). Bare import is jiti/virtual-aliased to the live class. |
| `internal-patch.ts` | `installPatch`/`retainThinkingStepsPatch` take a `theme: ThinkingThemeLike` param; removed `assertThinkingStepsTheme` + the internal `theme` import | The 0.80.x `theme` object is not re-exported from the package entry; theme is now sourced from the public `ctx.ui.theme` at `session_start`. |
| `internal-patch.ts` | Removed dead resolve helpers (`getPackageRoot`, `resolvePiCodingAgentInternalModuleUrl`, `importPiCodingAgentInternal`, `PI_CODING_AGENT_INTERNAL_MODULES`) and unused `hasVisibleThinkingContent` / top-level fallback | Obsolete after the bare-import switch. |
| `index.ts`, `render.ts` | `@mariozechner/pi-*` imports → `@earendil-works/pi-*` | Match the harness runtime packages. |
| `index.ts` | `session_start` participates only when `ctx.mode === "tui"` and owns/releases the patch per activation; RPC/print may still surface `hasUI`, but it is not the discriminator | TUI-only symmetric ownership; no UI-detection gate. |
| `tsconfig.json` | Replaced upstream standalone config with `extends: ../../tsconfig.json` (strict, `include: ./**/*.ts`) | Inherit the harness `paths` mapping that resolves `@earendil-works/pi-tui` from the pnpm store (matches `extensions/second-opinion`). |
| upstream `test/`, `CHANGELOG.md`, `assets/`, `package.json` | Not vendored | Tests use `node:test` (not the harness Vitest runner) and are coupled to the removed resolve-based API; extension needs no `package.json` (loads via `index.ts` convention, no non-aliased deps). |

## Verification

- Typecheck: `pnpm exec tsc --noEmit -p extensions/thinking-steps/tsconfig.json`
- Focused Vitest: `pnpm exec vitest run extensions/thinking-steps/test/internal-patch.test.ts extensions/thinking-steps/test/lifecycle.test.ts`
- Runtime load: `pi -p "…" -ne -e extensions/thinking-steps/index.ts` (exit 0 = imports resolve + registration runs).
- Functional (patch lands): the vendored patch flips `AssistantMessageComponent` thinking rendering from a native `Markdown` child to a `ThinkingStepsComponent` child against the live 0.80.7 class. Full visual confirmation needs an interactive session (TUI).

## Gotchas

- Lifecycle gotcha: only TUI sessions own the patch; release/retry stays symmetric per activation for shared-cwd handoff.
- Not in `scripts/lint-typecheck.mjs`'s typecheck list — run the tsconfig check above manually.
- The git-package pin (`git:github.com/fluxgear/pi-thinking-steps`) must stay removed from the Nix-managed settings, or both copies load.
