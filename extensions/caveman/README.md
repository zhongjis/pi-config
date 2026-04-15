# Caveman Extension

Injects a token-compression prompt into the pi agent system prompt to make it respond like a "smart caveman" — terse, technically precise, no fluff. Three intensity levels let you dial between light pruning and extreme compression.

---

## How It Works

On every `before_agent_start` event the extension prepends a compact instruction block to the system prompt. That block comes from `upstream-caveman.SKILL.md` (a vendored copy of the upstream [caveman skill](https://github.com/JuliusBrussee/caveman)) and is post-processed at load time to strip references to features the extension handles itself (e.g. `/caveman` switch instructions in the prelude).

Three levels are available:

| Level | What changes |
|-------|-------------|
| `lite` | Drops filler and hedging. Keeps articles and full sentences. Professional but tight. |
| `full` | Drops articles, fragments OK, short synonyms. Classic caveman. |
| `ultra` | Abbreviates (DB/auth/fn/impl), strips conjunctions, uses arrows for causality (X → Y), one word when one word is enough. |

Two wenyan (classical Chinese) levels (`wenyan-full`, `wenyan-ultra`) exist in the upstream skill source but are **not exposed** by this extension's level selector. They remain available in the raw skill file if you want to vendor them through the command in the future.

Level is injected as a compact one-liner (first paragraph of prelude + active level instruction + Rules/Auto-Clarity/Boundaries first paragraphs) rather than the full skill document, keeping the token footprint small.

---

## Infrastructure

```
extensions/caveman/
├── index.ts                    # Extension entry point — registers events and /caveman command
├── config.ts                   # Config types, file I/O, normalize/validate helpers
├── prompt.ts                   # Loads and parses upstream-caveman.SKILL.md, builds injected prompt
├── session-gate.ts             # Detects whether the session is a top-level persisted session
├── state.ts                    # In-memory runtime state (current level + config); restore/clear helpers
└── upstream-caveman.SKILL.md   # Vendored upstream caveman skill (source of truth for prompt content)
```

### config.ts

Owns the **persistent config** stored at `~/.pi/agent/caveman.json`:

```json
{
  "defaultLevel": "ultra",
  "statusVisibility": "active"
}
```

- `defaultLevel` — `"off"` | `"lite"` | `"full"` | `"ultra"`. When not `"off"`, caveman is auto-applied to every new session.
- `statusVisibility` — `"active"` (show status bar item when enabled) | `"hidden"` (no status bar item).

Uses `process.getBuiltinModule("fs")` and `process.getBuiltinModule("os")` rather than standard `import` because pi extensions run under [jiti](https://github.com/unjs/jiti) and Node built-ins must be accessed this way. Config is read from disk on every `session_start` and written immediately on change — no in-memory lag.

### prompt.ts

Loads `upstream-caveman.SKILL.md` once at `session_start` and caches the result for the process lifetime. The document is parsed into four required sections (`Rules`, `Intensity`, `Auto-Clarity`, `Boundaries`) plus a prelude. Two normalization passes strip the upstream switch instructions that this extension replaces with `/caveman` command UX.

`buildInjectedPrompt(level)` constructs the compact injection:
- First paragraph of prelude
- Active level + per-level instruction (parsed from the `Intensity` table)
- Inline collapsed first paragraphs of Rules, Auto-Clarity, Boundaries

This keeps injected tokens minimal.

### state.ts

Holds the **runtime state** for the current session:

```typescript
interface CavemanRuntimeState {
  config: CavemanConfig;     // persisted config, loaded at session_start
  sessionLevel?: CavemanLevel; // per-session override set via /caveman <level>
}
```

`getCavemanEffectiveLevel()` resolves `sessionLevel ?? config.defaultLevel` through `resolveCavemanEffectiveLevel()`, which normalizes `"off"` → `undefined`.

Per-session level is persisted in the session JSONL via `pi.appendEntry("caveman-level", { level })` so it survives `/resume`. On `session_start`, `restoreCavemanState` replays the session branch to find the latest `caveman-level` entry.

### session-gate.ts

`isTopLevelPersistedSession(ctx)` guards the `before_agent_start` hook — caveman is only injected into top-level persisted sessions. It checks `isPersisted()` and `getSessionFile()` signals, preferring the intersection when both are present.

This prevents injecting the prompt into ephemeral or subagent sessions where it would be noise.

---

## User Guide

### Enable for a session

```
/caveman lite
/caveman full
/caveman ultra
```

Level persists for the session and survives `/resume`. Run `/caveman` with no args to see current status.

### Disable for a session

To turn off caveman for the remainder of a session, open config and set Default level to `off`, or tell the agent `"stop caveman"` / `"normal mode"` (the prompt's built-in boundary rule will revert).

### Set a persistent default

```
/caveman config
```

Opens a dialog to set:
- **Default level** — applied automatically to every new session.
- **Status visibility** — whether `CAVEMAN: <level>` appears in the status bar.

Config is saved to `~/.pi/agent/caveman.json`.

### Status bar

When `statusVisibility` is `"active"` (the default), an item like `CAVEMAN: full` appears in the footer while caveman is active. Set it to `"hidden"` via `/caveman config` if you prefer a silent mode.

---

## Developer Guide

### Updating the upstream skill

The prompt content lives entirely in `upstream-caveman.SKILL.md`. To sync with upstream:

1. Fetch the latest `SKILL.md` from [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman/tree/main/skills/caveman).
2. Replace `upstream-caveman.SKILL.md` content.
3. Keep the sync-note comment at the top intact (lines 1–5).
4. Run the extension and verify `loadRuntimePrompt()` does not throw — it validates that `Rules`, `Intensity`, `Auto-Clarity`, and `Boundaries` sections are present and non-empty.
5. Review `prompt.ts` `normalizePrelude` and `normalizeBoundaries` — they strip upstream phrases that this extension handles differently. Update those regexes if the upstream phrasing changes.

### Adding a new level

1. Add the level string to `CAVEMAN_LEVELS` in `config.ts`.
2. Add a row to the `## Intensity` table in `upstream-caveman.SKILL.md`.
3. Update `COMMAND_ARGUMENTS` in `index.ts` if you want it in autocomplete.
4. `isCavemanLevel()` and all derived types update automatically.

### Audit: pi extension best practices

| Practice | Status | Notes |
|----------|--------|-------|
| Default export function receiving `ExtensionAPI` | ✅ | `export default function cavemanExtension(pi)` |
| `session_start` for state init | ✅ | `restoreCavemanState` + `loadRuntimePrompt` |
| `session_shutdown` for cleanup | ✅ | Clears in-memory state, removes status bar item |
| `before_agent_start` for system prompt injection | ✅ | Returns `{ systemPrompt }` |
| `registerCommand` with `getArgumentCompletions` | ✅ | Tab-completion for levels and `config` |
| `appendEntry` for session-persistent state | ✅ | `caveman-level` entries replayed on restore |
| `ctx.hasUI` guard before UI calls | ✅ | All `notify`/`setStatus` are guarded |
| `ctx.ui.setStatus` cleared on shutdown | ✅ | `setStatus("caveman", undefined)` |
| `isTopLevelPersistedSession` guard on injection | ✅ | Avoids injecting into subagent/ephemeral sessions |
| No `import` of Node built-ins (uses `getBuiltinModule`) | ✅ | Required for jiti compatibility |
| Error thrown from `session_start` propagates cleanly | ✅ | Caught, notified, re-thrown as `Error` |
| No `ExtensionAPI` import from pi (uses local interfaces) | ⚠️ | Extension defines its own `CavemanExtensionApi` interface instead of importing `ExtensionAPI` from `@mariozechner/pi-coding-agent`. This works because jiti resolves types structurally, but it means type safety against the real API is not enforced at author time. Consider importing the real type. |
| No tests | ⚠️ | Pure runtime behavior is hard to unit-test without pi harness. Consider extracting pure logic (prompt parsing, config normalization, session-level replay) into testable units. |

### Known gaps

**No formal type import from `@mariozechner/pi-coding-agent`**
The extension hand-rolls `CavemanExtensionApi` and related interfaces instead of importing `ExtensionAPI`. This is structurally compatible but bypasses compile-time checks if the upstream API changes. To fix, add the import:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export default function cavemanExtension(pi: ExtensionAPI): void { ... }
```

**No test coverage**
The config normalization, prompt parser, and session-level restoration logic are self-contained and testable. A vitest suite over `config.ts` and `prompt.ts` would catch regressions when syncing upstream.

**`wenyan` levels not exposed**
The upstream skill includes `wenyan-lite`, `wenyan-full`, and `wenyan-ultra` levels. They are present in the vendored skill file but are not wired into `CAVEMAN_LEVELS` or the command. This is intentional scope restriction, not a bug.
