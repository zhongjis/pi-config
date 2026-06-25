# Subagent Fork — Tier 2 Upstream Adoptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Back-port three high-ROI upstream `pi-subagents` features into the `@panda/pi-subagents` hard fork: (A) `toolDescriptionMode` compact, (B) `scopeModels` guardrail, (C) stop-agent-from-viewer (`x` key). Tier-2 item T2.3 (`exclude_extensions`) is explicitly OUT OF SCOPE.

**Architecture:** Each feature is an independent manual cherry-pick re-expressed in the fork's vocabulary — never a git merge. (A) and (B) add fields to the fork's dual-scope `subagents.json` settings; (C) is pure UI wiring through the existing `AgentManager.abort()` → `AgentRun` pipeline. All three respect the fork keystones: the `AgentRun` single-source-of-truth reducer and the `external-contract-adapter.ts` sole-emitter rule (we never emit `subagents:*` directly — `abort()` already routes through them).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui` ^0.79, Vitest, TypeBox tool schemas.

**Working dir:** `/Users/zshen/.herdr/worktrees/pi-config/subagent-upstream-sync` (branch `subagent-upstream-sync`; Tier 1 already landed in commit `264353c`). All extension paths below are under `extensions/subagent/`.

---

## Shared Context (read once)

**Upstream reference clone (already on disk):** `/tmp/pi-github-repos/tintinweb/pi-subagents` — features live at `src/settings.ts`, `src/enabled-models.ts`, `src/index.ts` (lines ~689–1010), `src/ui/conversation-viewer.ts`. Re-clone if absent: `git clone https://github.com/tintinweb/pi-subagents /tmp/pi-github-repos/tintinweb/pi-subagents`.

**Local invariants any port MUST respect (from `extensions/subagent/AGENTS.md`):**
- The `AgentRun` event-stream reducer is the single source of truth; `subagents:*` is emitted ONLY by `external-contract-adapter.ts`. `AgentManager.abort()` already publishes through this pipeline — do not add new emission.
- Frontmatter is authoritative. A frontmatter-pinned model that fails scope must WARN, not hard-error (only a caller-supplied `model:` param hard-errors).
- Fork frontmatter schema is `builtin_tools`/`extension_tools`/`extensions` (not upstream `tools:`/`ext:`).
- Nerd Font glyphs in the widget/viewer are intentional — do not overwrite.
- Dual-scope settings: global `~/.pi/agent/subagents.json` (read-only defaults) + project `<cwd>/.pi/subagents.json` (written by `/agents → Settings`); project overrides global on load (`loadSettings`).

**Verification commands (run from `extensions/subagent/`):**
```bash
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
```
Repo-wide gate (run from repo root `/Users/zshen/.herdr/worktrees/pi-config/subagent-upstream-sync`): `pnpm lint:typecheck` then `pnpm test`.

**Commit policy:** one commit per feature (A, B, C), plus one for the settings-menu wiring and one for the AGENTS.md manifest. Never commit unless the task says to. Conventional-commit prefix `feat(subagent):` / `docs(subagent):` matching Tier 1.

---

## File Structure

**Feature A — `toolDescriptionMode` compact:**
- Modify: `src/settings.ts` — add `ToolDescriptionMode` type + `toolDescriptionMode` field + sanitize + applier.
- Create: `src/runtime-flags.ts` — module-level mutable runtime flags with get/set (mirrors the `getGraceTurns/setGraceTurns` pattern in `agent-runner.ts`).
- Create: `src/agent-tool-description.ts` — pure `buildAgentToolDescription(mode, full, compact)` builder.
- Modify: `src/lifecycle/supervision.ts` — `buildCompactTypeListText`, wire applier + `compactTypeListText` into `SubagentRuntimeContext`.
- Modify: `src/tools/agent.ts` — replace inline `description` literal with the builder.
- Create: `test/agent-tool-description.test.ts`. Modify: `test/settings.test.ts`.

**Feature B — `scopeModels` guardrail:**
- Modify: `src/settings.ts` — add `scopeModels` field + sanitize + applier.
- Modify: `src/runtime-flags.ts` — add `scopeModels` flag get/set.
- Create: `src/enabled-models.ts` — port from upstream + add pure `decideModelScope()`.
- Modify: `src/lifecycle/supervision.ts` — wire the `setScopeModels` applier.
- Modify: `src/tools/agent.ts` — guardrail after model resolution.
- Create: `test/enabled-models.test.ts`. Modify: `test/settings.test.ts`.

**Feature C — stop-from-viewer (`x`):**
- Modify: `src/ui/conversation-viewer.ts` — `stopArmed` field, `onStop` ctor param, `x` handler, footer hint.
- Modify: `src/ui-wiring/commands.ts` — pass `onStop: () => manager.abort(record.id)`.
- Modify: `test/conversation-viewer.test.ts`.

**Feature D — settings menu toggles (depends on A + B):**
- Modify: `src/ui-wiring/commands.ts` — `snapshotSettings` + `showSettings` menu entries.

**Feature E — manifest:**
- Modify: `extensions/subagent/AGENTS.md` — add Local Tweaks rows.

---

## FEATURE A — `toolDescriptionMode` compact (upstream v0.10.2)

Default `"full"` (current behavior, byte-identical). `"compact"` swaps the ~1.4k-token Agent tool description for a terse one + first-sentence-only agent list, saving tokens for small/local models. (Upstream's third mode `"custom"` — user-authored description file with placeholder substitution — is intentionally deferred; it is separable and the audit's value driver is `compact`. Add later if requested.)

### Task A1: Settings type, field, sanitize, applier

**Files:**
- Modify: `src/settings.ts`
- Test: `test/settings.test.ts`

- [ ] **Step 1: Write the failing test** — append to `test/settings.test.ts`. Merge the imports below into the file's existing import block (do NOT duplicate `describe`/`it`/`expect` if already imported):

```typescript
import { describe, expect, it } from "vitest";
// `loadSettings`/`sanitize` are not exported individually; sanitize is exercised
// through readSettingsFile/loadSettings. Test via a written project file instead:
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../src/settings.js";

describe("toolDescriptionMode setting", () => {
  function writeProject(obj: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "subagents-settings-"));
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify(obj), "utf-8");
    return dir;
  }

  it("accepts 'full' and 'compact'", () => {
    expect(loadSettings(writeProject({ toolDescriptionMode: "compact" })).toolDescriptionMode).toBe("compact");
    expect(loadSettings(writeProject({ toolDescriptionMode: "full" })).toolDescriptionMode).toBe("full");
  });

  it("drops invalid modes", () => {
    expect(loadSettings(writeProject({ toolDescriptionMode: "tiny" })).toolDescriptionMode).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm run test -- settings` (from `extensions/subagent/`)
Expected: FAIL — `toolDescriptionMode` not present on the returned object (field not yet sanitized).

- [ ] **Step 3: Add the type + field + sanitize + applier** in `src/settings.ts`:

After the `SubagentsSettings` interface (currently ends at line 19), add the exported type and field. Change the interface to include the field and add the type alias right after it:

```typescript
export type ToolDescriptionMode = "full" | "compact";

export interface SubagentsSettings {
  maxConcurrent?: number;
  /**
   * 0 = unlimited — the extension's single source of truth for that convention:
   * `normalizeMaxTurns()` in agent-runner.ts treats 0 → `undefined`, and the
   * `/agents` → Settings input prompt explicitly says "0 = unlimited".
   */
  defaultMaxTurns?: number;
  graceTurns?: number;
  /** Agent tool description verbosity. `compact` ≈ 75% smaller. Applied at tool registration (next session). */
  toolDescriptionMode?: ToolDescriptionMode;
}
```

In `SettingsAppliers` (lines 22–26) add the setter:

```typescript
export interface SettingsAppliers {
  setMaxConcurrent: (n: number) => void;
  setDefaultMaxTurns: (n: number) => void;
  setGraceTurns: (n: number) => void;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
}
```

In `sanitize()` (before `return out;` at line 65) add validation:

```typescript
  if (r.toolDescriptionMode === "full" || r.toolDescriptionMode === "compact") {
    out.toolDescriptionMode = r.toolDescriptionMode;
  }
```

In `applySettings()` (lines 114–118) add:

```typescript
  if (typeof s.toolDescriptionMode === "string") appliers.setToolDescriptionMode(s.toolDescriptionMode);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- settings`
Expected: PASS.

### Task A2: Runtime-flags module

**Files:**
- Create: `src/runtime-flags.ts`

- [ ] **Step 1: Create `src/runtime-flags.ts`** (module-level mutable state, mirroring the `setGraceTurns` pattern in `agent-runner.ts`):

```typescript
// Mutable runtime flags persisted via subagents.json and toggled from /agents → Settings.
// Module-level state so both the runtime hub (read) and the /agents command (write) share one source.
import type { ToolDescriptionMode } from "./settings.js";

let toolDescriptionMode: ToolDescriptionMode = "full";

export function getToolDescriptionMode(): ToolDescriptionMode {
  return toolDescriptionMode;
}

export function setToolDescriptionMode(mode: ToolDescriptionMode): void {
  toolDescriptionMode = mode;
}
```

- [ ] **Step 2: Typecheck** — Run: `pnpm run typecheck`. Expected: PASS (file unused so far, but valid).

### Task A3: Description builder (pure, tested)

**Files:**
- Create: `src/agent-tool-description.ts`
- Test: `test/agent-tool-description.test.ts`

- [ ] **Step 1: Write the failing test** — create `test/agent-tool-description.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildAgentToolDescription } from "../src/agent-tool-description.js";

const full = "Default agents:\n- general-purpose: Does everything.";
const compact = "- general-purpose: Does everything.";

describe("buildAgentToolDescription", () => {
  it("full mode embeds the full type list and the guideline bullets", () => {
    const out = buildAgentToolDescription("full", full, compact);
    expect(out).toContain("Default agents:");
    expect(out).toContain("- For parallel work, use run_in_background");
    expect(out).toContain("inherit_context");
  });

  it("compact mode is materially shorter and uses the compact list", () => {
    const fullOut = buildAgentToolDescription("full", full, compact);
    const compactOut = buildAgentToolDescription("compact", full, compact);
    expect(compactOut.length).toBeLessThan(fullOut.length * 0.6);
    expect(compactOut).toContain("- general-purpose: Does everything.");
    expect(compactOut).not.toContain("Default agents:");
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — Run: `pnpm run test -- agent-tool-description`. Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/agent-tool-description.ts`** with the full description lifted verbatim from `src/tools/agent.ts:189-206`:

```typescript
import type { ToolDescriptionMode } from "./settings.js";

/** Full Claude-Code-style description — byte-identical to the pre-feature inline literal. */
function fullDescription(typeListText: string): string {
  return `Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types:
${typeListText}

Guidelines:
- For parallel work, use run_in_background: true on each agent. Foreground calls run sequentially — only one executes at a time.
- Leave max_turns unset unless you need an explicit cap. Unset is the normal unlimited-by-default behavior.
- Background agents require active supervision: check progress with get_subagent_result, use steer_subagent for mid-run course correction, and use resume to continue the same agent instead of starting duplicate work.
- If a background agent is still useful, keep supervising it rather than launching overlapping duplicate work or leaving it unattended for long periods.
- Choose an available custom agent whose description matches the task.
- Provide clear, detailed prompts so the agent can work autonomously.
- Agent results are returned as text; summarize them for the user.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.`;
}

/** ~75% smaller: terse intro, first-sentence-only agent list, one notes line. */
function compactDescription(compactTypeListText: string): string {
  return `Launch a specialized agent to handle a complex task autonomously.

Available agent types:
${compactTypeListText}

Notes: run_in_background:true runs in parallel — supervise with get_subagent_result / steer_subagent / resume. Optional params: model ("provider/modelId" or fuzzy), thinking, max_turns, isolated, inherit_context.`;
}

export function buildAgentToolDescription(
  mode: ToolDescriptionMode,
  typeListText: string,
  compactTypeListText: string,
): string {
  return mode === "compact" ? compactDescription(compactTypeListText) : fullDescription(typeListText);
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `pnpm run test -- agent-tool-description`. Expected: PASS.

### Task A4: Compact type list + wire applier + context field

**Files:**
- Modify: `src/lifecycle/supervision.ts`

- [ ] **Step 1: Add the applier** in `applyAndEmitLoaded` call (supervision.ts lines 593–600). First add the import near the existing `import { applyAndEmitLoaded, ... } from "../settings.js"` (line 39) and the runtime-flags import:

```typescript
import { setToolDescriptionMode, getToolDescriptionMode } from "../runtime-flags.js";
```

Then extend the appliers object (lines 594–598):

```typescript
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setDefaultMaxTurns,
      setGraceTurns,
      setToolDescriptionMode: (mode) => setToolDescriptionMode(mode),
    },
    (event, payload) => pi.events.emit(event, payload),
  );
```

- [ ] **Step 2: Add `buildCompactTypeListText` + `firstSentence`** immediately after `buildTypeListText`'s definition (after line 669) and compute the compact list after line 672 (`const typeListText = buildTypeListText();`):

```typescript
  const firstSentence = (s: string): string => {
    const m = s.match(/^.*?[.!?](\s|$)/);
    return (m ? m[0] : s).trim();
  };

  /** Compact agent list: first-sentence-only descriptions, no model suffix, no footer. */
  const buildCompactTypeListText = () => {
    const names = [...getDefaultAgentNames(), ...getUserAgentNames()];
    return names
      .map((name) => {
        const cfg = getAgentConfig(name);
        return `- ${name}: ${firstSentence(cfg?.description ?? name)}`;
      })
      .join("\n");
  };
```

And after line 672:

```typescript
  const compactTypeListText = buildCompactTypeListText();
```

- [ ] **Step 3: Add `compactTypeListText` to `SubagentRuntimeContext`** interface (after `typeListText: string;` at line 272):

```typescript
  typeListText: string;
  compactTypeListText: string;
```

- [ ] **Step 4: Add it to the `runtimeContext` object** (after `typeListText,` at line 778):

```typescript
    typeListText,
    compactTypeListText,
```

- [ ] **Step 5: Typecheck** — Run: `pnpm run typecheck`. Expected: PASS.

### Task A5: Use the builder in the Agent tool

**Files:**
- Modify: `src/tools/agent.ts`

- [ ] **Step 1: Add imports** to `src/tools/agent.ts` (top of file, with the other relative imports):

```typescript
import { buildAgentToolDescription } from "../agent-tool-description.js";
import { getToolDescriptionMode } from "../runtime-flags.js";
```

- [ ] **Step 2: Destructure `compactTypeListText`** in `registerAgentTool` (lines 175–184), adding it next to `typeListText`:

```typescript
  const {
    pi,
    widget,
    manager,
    agentActivity,
    requireSpawnableType,
    bindTurnAbortSignal,
    getAbortSignal,
    typeListText,
    compactTypeListText,
  } = ctx;
```

- [ ] **Step 3: Replace the inline `description` literal** (the entire template-literal value at lines 189–206) with:

```typescript
    description: buildAgentToolDescription(getToolDescriptionMode(), typeListText, compactTypeListText),
```

- [ ] **Step 4: Typecheck + full test** — Run: `pnpm run typecheck && pnpm run test`. Expected: PASS. The default-`full` path must keep existing tests green (description byte-identical).

- [ ] **Step 5: Manual QA** — temporarily set compact mode and confirm the registered description shrinks. From `extensions/subagent/`:

```bash
node --input-type=module -e "
import { buildAgentToolDescription } from './src/agent-tool-description.js';
const full = 'Default agents:\n- a: Long description here. Second sentence.';
const compact = '- a: Long description here.';
const f = buildAgentToolDescription('full', full, compact);
const c = buildAgentToolDescription('compact', full, compact);
console.log('full chars:', f.length, 'compact chars:', c.length, 'ratio:', (c.length/f.length).toFixed(2));
"
```
Expected: compact ratio < 0.6. (If `src/` is not pre-compiled, run via the project's test runner instead; the A3 test already asserts the ratio.)

- [ ] **Step 6: Commit**

```bash
git add extensions/subagent/src/settings.ts extensions/subagent/src/runtime-flags.ts extensions/subagent/src/agent-tool-description.ts extensions/subagent/src/lifecycle/supervision.ts extensions/subagent/src/tools/agent.ts extensions/subagent/test/agent-tool-description.test.ts extensions/subagent/test/settings.test.ts
git commit -m "feat(subagent): port toolDescriptionMode compact (upstream #0.10.2)"
```

---

## FEATURE B — `scopeModels` guardrail (upstream v0.9.0)

Off by default. When `scopeModels: true` AND pi's settings has a non-empty `enabledModels`, validate the effective subagent model against that allowlist. Caller-supplied `model:` param out of scope → hard error (block spawn). Frontmatter-pinned or parent-inherited out of scope → warning toast, spawn proceeds (frontmatter is authoritative). No-op when `enabledModels` is empty/absent.

### Task B1: Settings field, sanitize, applier, runtime flag

**Files:**
- Modify: `src/settings.ts`, `src/runtime-flags.ts`
- Test: `test/settings.test.ts`

- [ ] **Step 1: Write the failing test** — append to `test/settings.test.ts`:

```typescript
describe("scopeModels setting", () => {
  function writeProject(obj: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "subagents-scope-"));
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify(obj), "utf-8");
    return dir;
  }
  it("accepts a boolean", () => {
    expect(loadSettings(writeProject({ scopeModels: true })).scopeModels).toBe(true);
  });
  it("drops non-boolean", () => {
    expect(loadSettings(writeProject({ scopeModels: "yes" })).scopeModels).toBeUndefined();
  });
});
```

(Reuse the `mkdtempSync`/`writeFileSync`/`mkdirSync`/`tmpdir`/`join`/`loadSettings` imports added in Task A1.)

- [ ] **Step 2: Run it, verify it fails** — Run: `pnpm run test -- settings`. Expected: FAIL — `scopeModels` undefined.

- [ ] **Step 3: Add field + sanitize + applier** in `src/settings.ts`:

In `SubagentsSettings` add:

```typescript
  /** When true, validate effective subagent models against pi's enabledModels. Off by default. */
  scopeModels?: boolean;
```

In `SettingsAppliers` add:

```typescript
  setScopeModels: (on: boolean) => void;
```

In `sanitize()` (before `return out;`):

```typescript
  if (typeof r.scopeModels === "boolean") {
    out.scopeModels = r.scopeModels;
  }
```

In `applySettings()`:

```typescript
  if (typeof s.scopeModels === "boolean") appliers.setScopeModels(s.scopeModels);
```

- [ ] **Step 4: Add the runtime flag** to `src/runtime-flags.ts`:

```typescript
let scopeModels = false;

export function getScopeModels(): boolean {
  return scopeModels;
}

export function setScopeModels(on: boolean): void {
  scopeModels = on;
}
```

- [ ] **Step 5: Run test to verify it passes** — Run: `pnpm run test -- settings`. Expected: PASS.

### Task B2: Port `enabled-models.ts` + add `decideModelScope`

**Files:**
- Create: `src/enabled-models.ts`
- Test: `test/enabled-models.test.ts`

- [ ] **Step 1: Write the failing test** — create `test/enabled-models.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnabledModels, isModelInScope, decideModelScope } from "../src/enabled-models.js";

describe("readEnabledModels", () => {
  it("project overrides global (returns project array)", () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-"));
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }), "utf-8");
    expect(readEnabledModels(dir)).toEqual(["anthropic/claude-haiku-4-5"]);
  });
  it("undefined when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-empty-"));
    expect(readEnabledModels(dir)).toBeUndefined();
  });
});

describe("isModelInScope", () => {
  it("case-insensitive provider/id membership", () => {
    const allowed = new Set(["anthropic/claude-haiku-4-5"]);
    expect(isModelInScope({ provider: "Anthropic", id: "Claude-Haiku-4-5" }, allowed)).toBe(true);
    expect(isModelInScope({ provider: "anthropic", id: "claude-opus-4-6" }, allowed)).toBe(false);
  });
});

describe("decideModelScope", () => {
  const allowed = new Set(["anthropic/claude-haiku-4-5"]);
  it("allows when no allowlist (no-op)", () => {
    expect(decideModelScope({ model: { provider: "anthropic", id: "x" }, modelFromParams: true, allowed: undefined }).action).toBe("allow");
  });
  it("allows when in scope", () => {
    expect(decideModelScope({ model: { provider: "anthropic", id: "claude-haiku-4-5" }, modelFromParams: true, allowed }).action).toBe("allow");
  });
  it("blocks a caller-supplied out-of-scope model", () => {
    const d = decideModelScope({ model: { provider: "anthropic", id: "claude-opus-4-6" }, modelFromParams: true, allowed });
    expect(d.action).toBe("block");
    expect(d.action === "block" && d.message).toContain("anthropic/claude-haiku-4-5");
  });
  it("warns (does not block) a frontmatter/inherited out-of-scope model", () => {
    const d = decideModelScope({ model: { provider: "anthropic", id: "claude-opus-4-6" }, modelFromParams: false, allowed });
    expect(d.action).toBe("warn");
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — Run: `pnpm run test -- enabled-models`. Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/enabled-models.ts`** — port the upstream file (`/tmp/pi-github-repos/tintinweb/pi-subagents/src/enabled-models.ts`) verbatim, then append the pure `decideModelScope`. The upstream import `import type { ModelEntry } from "./model-resolver.js";` resolves in the fork (`src/model-resolver.ts` re-exports `ModelEntry` from `../../lib/model.js`). Full file:

```typescript
/**
 * Reads `enabledModels` from pi's settings (global `<agentDir>/settings.json`
 * + project-local `<cwd>/.pi/settings.json`, project wins) and resolves
 * entries to concrete `provider/modelId` keys for scope validation.
 *
 * Project overrides global, mirroring pi's SettingsManager deep-merge and our
 * own loadSettings precedence (src/settings.ts). Only exact `provider/modelId`
 * patterns are matched (case-insensitive); globs, bare IDs, and `:thinking`
 * suffixes are silently dropped (pi's scoped-models picker writes exact keys).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelEntry } from "./model-resolver.js";

/** Minimal registry shape — only what resolveEnabledModels calls. */
export interface ModelRegistryRef {
  getAll(): unknown[];
  getAvailable?(): unknown[];
}

/** Paths to pi's settings.json files: [project, global] (project takes precedence). */
function settingsPaths(cwd: string): [project: string, global: string] {
  return [join(cwd, ".pi", "settings.json"), join(getAgentDir(), "settings.json")];
}

/** Read `enabledModels` from a single settings.json file. Undefined when missing or absent. */
function readField(path: string): string[] | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(raw?.enabledModels)) return raw.enabledModels as string[];
  } catch {
    /* corrupt file — silent */
  }
  return undefined;
}

/** Read enabledModels from pi's settings — project-local overrides global. */
export function readEnabledModels(cwd: string): string[] | undefined {
  const [project, global] = settingsPaths(cwd);
  return readField(project) ?? readField(global);
}

// Module-level cache — invalidated when either settings.json changes or patterns differ.
let cachedAllowed: Set<string> | undefined;
let cachedHash = "";
let cachedPatternsKey = "";

function hashOf(path: string): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}-${s.size}`;
  } catch {
    return "missing";
  }
}

export function resolveEnabledModels(
  patterns: string[] | undefined,
  registry: ModelRegistryRef,
  cwd: string = process.cwd(),
): Set<string> | undefined {
  const patternsKey = JSON.stringify(patterns);
  const [project, global] = settingsPaths(cwd);
  const fileHash = `${hashOf(project)};${hashOf(global)}`;

  if (fileHash === cachedHash && patternsKey === cachedPatternsKey) {
    return cachedAllowed;
  }

  if (!patterns || patterns.length === 0) {
    cachedHash = fileHash;
    cachedPatternsKey = patternsKey;
    cachedAllowed = undefined;
    return undefined;
  }

  const available = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const allowed = new Set<string>();

  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    resolveExact(trimmed, available, allowed);
  }

  const result = allowed.size > 0 ? allowed : undefined;
  cachedHash = fileHash;
  cachedPatternsKey = patternsKey;
  cachedAllowed = result;
  return result;
}

/** Canonical lowercase `provider/id` key for the allowed set. */
function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`.toLowerCase();
}

/** True when `model` is in the allowed set. */
export function isModelInScope(
  model: { provider: string; id: string },
  allowed: Set<string>,
): boolean {
  return allowed.has(modelKey(model));
}

/** Resolve exact `provider/modelId` pattern against available models. */
function resolveExact(pattern: string, available: ModelEntry[], allowed: Set<string>): void {
  const slashIdx = pattern.indexOf("/");
  if (slashIdx === -1) return; // bare modelId not supported
  const provider = pattern.slice(0, slashIdx).toLowerCase();
  const modelId = pattern.slice(slashIdx + 1).toLowerCase();
  const exact = available.find(
    (m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId,
  );
  if (exact) allowed.add(modelKey(exact));
}

export type ScopeDecision =
  | { action: "allow" }
  | { action: "block"; message: string }
  | { action: "warn"; message: string };

/**
 * Pure scope decision. `allowed === undefined` (no scope configured) is a no-op.
 * Caller-supplied model out of scope → block; frontmatter/inherited → warn
 * (frontmatter is authoritative — never hard-error those).
 */
export function decideModelScope(opts: {
  model: { provider: string; id: string } | undefined;
  modelFromParams: boolean;
  allowed: Set<string> | undefined;
}): ScopeDecision {
  const { model, modelFromParams, allowed } = opts;
  if (!model || !allowed || allowed.size === 0) return { action: "allow" };
  if (isModelInScope(model, allowed)) return { action: "allow" };
  const list = [...allowed].map((m) => `  ${m}`).join("\n");
  const message = `Model not in scope: "${model.provider}/${model.id}".\n\nAllowed models:\n${list}`;
  return modelFromParams ? { action: "block", message } : { action: "warn", message };
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `pnpm run test -- enabled-models`. Expected: PASS.

### Task B3: Wire the applier + the guardrail at spawn

**Files:**
- Modify: `src/lifecycle/supervision.ts`, `src/tools/agent.ts`

- [ ] **Step 1: Wire the applier** in `src/lifecycle/supervision.ts`. Extend the runtime-flags import added in Task A4:

```typescript
import { setToolDescriptionMode, getToolDescriptionMode, setScopeModels } from "../runtime-flags.js";
```

Add to the appliers object in `applyAndEmitLoaded` (after `setToolDescriptionMode`):

```typescript
      setToolDescriptionMode: (mode) => setToolDescriptionMode(mode),
      setScopeModels: (on) => setScopeModels(on),
```

- [ ] **Step 2: Add imports** to `src/tools/agent.ts` (with the other relative imports):

```typescript
import { getScopeModels } from "../runtime-flags.js";
import { readEnabledModels, resolveEnabledModels, decideModelScope, type ModelRegistryRef } from "../enabled-models.js";
```

- [ ] **Step 3: Insert the guardrail** in the Agent tool `execute` (`src/tools/agent.ts`), immediately AFTER the model-resolution block (after line 384, the closing `}` of `if (resolvedConfig.modelCandidates.length > 0) { ... }`) and BEFORE `const thinking = effectiveThinking;` (line 386). Inside `execute`, the inner pi context is named `ctx` (it shadows the outer `SubagentRuntimeContext`, but we read `getScopeModels()` from the module and `ctx.modelRegistry`/`ctx.ui` from the exec ctx):

```typescript
      // scopeModels guardrail: validate the effective model against pi's enabledModels.
      if (getScopeModels() && model) {
        const cwd = process.cwd();
        const patterns = readEnabledModels(cwd);
        const allowed = resolveEnabledModels(patterns, ctx.modelRegistry as unknown as ModelRegistryRef, cwd);
        const decision = decideModelScope({
          model: { provider: model.provider, id: model.id },
          modelFromParams: resolvedConfig.modelFromParams,
          allowed,
        });
        if (decision.action === "block") {
          return textResult(decision.message);
        }
        if (decision.action === "warn") {
          ctx.ui.notify(decision.message, "warning");
        }
      }
```

Note: `model` here is the resolved `ModelEntry` (has `.provider`/`.id` — confirmed at supervision.ts:255). `ctx.ui.notify(text, level)` is the established toast API (see `extensions/lib/logger.ts:122`). `textResult` is already imported and used at lines 339/378.

- [ ] **Step 4: Typecheck + full test** — Run: `pnpm run typecheck && pnpm run test`. Expected: PASS. With `scopeModels` off (default) the guardrail is skipped, so existing tests stay green.

- [ ] **Step 5: Manual QA** — confirm the no-op default and the block path. From `extensions/subagent/`:

```bash
node --input-type=module -e "
import { decideModelScope } from './src/enabled-models.js';
console.log('default(no allowlist):', decideModelScope({model:{provider:'anthropic',id:'x'},modelFromParams:true,allowed:undefined}).action);
const allowed = new Set(['anthropic/claude-haiku-4-5']);
console.log('param out-of-scope:', decideModelScope({model:{provider:'anthropic',id:'claude-opus-4-6'},modelFromParams:true,allowed}).action);
console.log('frontmatter out-of-scope:', decideModelScope({model:{provider:'anthropic',id:'claude-opus-4-6'},modelFromParams:false,allowed}).action);
"
```
Expected output: `allow`, `block`, `warn`.

- [ ] **Step 6: Commit**

```bash
git add extensions/subagent/src/settings.ts extensions/subagent/src/runtime-flags.ts extensions/subagent/src/enabled-models.ts extensions/subagent/src/lifecycle/supervision.ts extensions/subagent/src/tools/agent.ts extensions/subagent/test/enabled-models.test.ts extensions/subagent/test/settings.test.ts
git commit -m "feat(subagent): port scopeModels guardrail (upstream #0.9.0)"
```

---

## FEATURE C — stop agent from viewer, `x` key (upstream v0.10.0)

Two-press `x` confirm in the conversation viewer aborts a running/queued agent via the existing `AgentManager.abort(id)` (which publishes the stop through `AgentRun` → `external-contract-adapter`). First `x` arms; second `x` confirms; any other key disarms. No new event emission.

### Task C1: Viewer `x` handler + footer hint

**Files:**
- Modify: `src/ui/conversation-viewer.ts`
- Test: `test/conversation-viewer.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `test/conversation-viewer.test.ts` (it already constructs `ConversationViewer`; mirror the existing construction shape — the new 7th ctor arg is the `onStop` callback). Add a `describe`:

```typescript
describe("ConversationViewer stop (x key)", () => {
  function makeViewer(status: string, onStop?: () => void) {
    const tui = { requestRender: () => {}, terminal: { rows: 40 } } as any;
    const session = { subscribe: () => () => {}, messages: [] } as any;
    const record = { id: "a1", type: "general-purpose", status, description: "d", startedAt: 0 } as any;
    const { ConversationViewer } = require("../src/ui/conversation-viewer.js"); // or the test's existing dynamic import
    return new ConversationViewer(tui, session, record, undefined, {} as any, () => {}, onStop);
  }

  it("first x arms, second x calls onStop when running", () => {
    let stopped = 0;
    const v = makeViewer("running", () => { stopped++; });
    v.handleInput("x");
    expect(stopped).toBe(0);
    v.handleInput("x");
    expect(stopped).toBe(1);
  });

  it("any other key disarms", () => {
    let stopped = 0;
    const v = makeViewer("running", () => { stopped++; });
    v.handleInput("x");      // arm
    v.handleInput("j");      // disarm (scroll)
    v.handleInput("x");      // arm again, not confirm
    expect(stopped).toBe(0);
  });

  it("x is inert when not stoppable or onStop missing", () => {
    let stopped = 0;
    const completed = makeViewer("completed", () => { stopped++; });
    completed.handleInput("x");
    completed.handleInput("x");
    expect(stopped).toBe(0);
  });
});
```

> If the existing test file uses a top-level `const { ConversationViewer } = await import(...)`, reuse that binding instead of `require` and adapt `makeViewer` to take it as a param. Match the file's existing import style (see `test/conversation-viewer.test.ts:26`). The theme object can be `{} as any` for these tests since `handleInput` does not render.

- [ ] **Step 2: Run it, verify it fails** — Run: `pnpm run test -- conversation-viewer`. Expected: FAIL — `onStop` ignored, `stopped` stays 0 on second `x`.

- [ ] **Step 3: Add the ctor param + field + `isStoppable`** in `src/ui/conversation-viewer.ts`. Add the field near the other private fields (after line 24 `private closed = false;`):

```typescript
  private stopArmed = false;
```

Add `onStop` as a new optional ctor parameter (after `done` at line 32):

```typescript
  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    private onStop?: () => void,
  ) {
```

Add a private helper (in the `// ---- Private ----` section, e.g. after `viewportHeight`):

```typescript
  private isStoppable(): boolean {
    return this.onStop != null && (this.record.status === "running" || this.record.status === "queued");
  }
```

- [ ] **Step 4: Handle `x` in `handleInput`** (lines 40–70). Insert the `x` block right after the `escape`/`q` block (after line 45's `}`), and add the disarm-on-any-other-key at the very end of `handleInput` (after the scroll `if/else` chain closes at line 69):

```typescript
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }
```

And at the end of `handleInput`, after the final `}` of the `else if (matchesKey(data, "end"))` chain (line 69) and before the method's closing `}` (line 70):

```typescript
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }

    // Any non-x key disarms a pending stop confirmation.
    if (this.stopArmed) this.stopArmed = false;
  }
```

- [ ] **Step 5: Footer hint** — update the footer in `render()` (line 140). Replace the single `footerRight` assignment with an armed-aware version:

```typescript
    const footerRight = this.stopArmed
      ? th.fg("error", "Press x again to STOP · any key cancels")
      : th.fg("dim", `↑↓ scroll · PgUp/PgDn · Esc close${this.isStoppable() ? " · x stop" : ""}`);
```

- [ ] **Step 6: Run test to verify it passes** — Run: `pnpm run test -- conversation-viewer`. Expected: PASS.

### Task C2: Wire `onStop` from the `/agents` viewer launcher

**Files:**
- Modify: `src/ui-wiring/commands.ts`

- [ ] **Step 1: Pass the callback** at the `ConversationViewer` instantiation (commands.ts line 203). `manager` is already in scope (destructured from `ctx` at line 24) and `record.id` is available:

```typescript
      (tui, theme, _keybindings, done) => {
        return new ConversationViewer(tui, session, record, activity, theme, done, () => {
          manager.abort(record.id);
        });
      },
```

- [ ] **Step 2: Typecheck + full test** — Run: `pnpm run typecheck && pnpm run test`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add extensions/subagent/src/ui/conversation-viewer.ts extensions/subagent/src/ui-wiring/commands.ts extensions/subagent/test/conversation-viewer.test.ts
git commit -m "feat(subagent): wire stop-agent-from-viewer x key (upstream #0.10.0)"
```

---

## FEATURE D — `/agents → Settings` toggles (depends on A + B)

Expose `scopeModels` and `toolDescriptionMode` through the existing settings menu so users don't hand-edit `subagents.json`.

### Task D1: Persist the new fields + add menu entries

**Files:**
- Modify: `src/ui-wiring/commands.ts`

- [ ] **Step 1: Import the getters/setters** at the top of `src/ui-wiring/commands.ts`:

```typescript
import { getScopeModels, setScopeModels, getToolDescriptionMode, setToolDescriptionMode } from "../runtime-flags.js";
```

- [ ] **Step 2: Persist them in `snapshotSettings`** (lines 537–543):

```typescript
  function snapshotSettings(): SubagentsSettings {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      scopeModels: getScopeModels(),
      toolDescriptionMode: getToolDescriptionMode(),
    };
  }
```

- [ ] **Step 3: Add the menu entries** in `showSettings` (the `ctx.ui.select("Settings", [...])` array at lines 555–559):

```typescript
    const choice = await ctx.ui.select("Settings", [
      `Max concurrency (current: ${manager.getMaxConcurrent()})`,
      `Default max turns (current: ${getDefaultMaxTurns() ?? "unlimited"})`,
      `Grace turns (current: ${getGraceTurns()})`,
      `Scope models (current: ${getScopeModels() ? "on" : "off"})`,
      `Tool description (current: ${getToolDescriptionMode()})`,
    ]);
```

- [ ] **Step 4: Add the handler branches** — append to the `if/else if` chain in `showSettings`, after the `Grace turns` branch (before its closing `}` at line 598/599):

```typescript
    } else if (choice.startsWith("Scope models")) {
      const next = !getScopeModels();
      setScopeModels(next);
      notifyApplied(ctx, `Scope models ${next ? "enabled" : "disabled"}`);
    } else if (choice.startsWith("Tool description")) {
      const next = getToolDescriptionMode() === "compact" ? "full" : "compact";
      setToolDescriptionMode(next);
      notifyApplied(ctx, `Tool description set to ${next} (applies next session)`);
    }
```

(`notifyApplied` already calls `saveAndEmitChanged(snapshotSettings(), ...)`, so the toggles persist.)

- [ ] **Step 5: Typecheck + full test + build** — Run: `pnpm run typecheck && pnpm run test && pnpm run build`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/subagent/src/ui-wiring/commands.ts
git commit -m "feat(subagent): expose scopeModels + toolDescriptionMode in /agents settings"
```

---

## FEATURE E — Update the divergence manifest

### Task E1: Record the new Local Tweaks

**Files:**
- Modify: `extensions/subagent/AGENTS.md`

- [ ] **Step 1: Append rows to the "Local Tweaks" table** (the table starting near line 69). Add:

```markdown
| `src/settings.ts`, `src/runtime-flags.ts` | Added `toolDescriptionMode` (`full`/`compact`) + `scopeModels` settings, module-level runtime flags | Ported upstream toolDescriptionMode (#0.10.2) + scopeModels (#0.9.0) in fork vocabulary |
| `src/agent-tool-description.ts` | Local-only file | `buildAgentToolDescription(mode, full, compact)` — full byte-identical to prior inline literal; compact ≈75% smaller |
| `src/enabled-models.ts` | Ported from upstream + local `decideModelScope` | scopeModels guardrail; caller-param out-of-scope blocks, frontmatter/inherited warns (frontmatter authoritative) |
| `src/ui/conversation-viewer.ts` | `stopArmed` + `onStop` two-press `x` confirm | Stop agent from viewer (#0.10.0); aborts via `AgentManager.abort` → AgentRun pipeline (no new emission) |
```

- [ ] **Step 2: Commit**

```bash
git add extensions/subagent/AGENTS.md
git commit -m "docs(subagent): record Tier 2 adoptions in divergence manifest"
```

---

## Final verification

- [ ] From `extensions/subagent/`: `pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run build` — all green.
- [ ] From repo root: `pnpm lint:typecheck && pnpm test` — all green (Tier-1's 469-test baseline + new tests, no regressions).
- [ ] Confirm default behavior is unchanged: `toolDescriptionMode` defaults to `full` (description byte-identical), `scopeModels` defaults to `false` (guardrail skipped), viewer `x` only acts when an `onStop` is wired and the agent is running/queued.

---

## Self-Review

**1. Spec coverage:**
- T2.1 toolDescriptionMode compact → Feature A (settings field, builder, compact list, wiring) + Feature D menu. ✓ (`custom` mode deliberately deferred — noted.)
- T2.2 scopeModels guardrail → Feature B (settings field, enabled-models port, decision + spawn guardrail) + Feature D menu. ✓
- T2.4 stop-from-viewer → Feature C (viewer handler + commands wiring). ✓
- T2.3 exclude_extensions → intentionally OUT OF SCOPE. ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — every code step shows full content. ✓

**3. Type consistency:** `ToolDescriptionMode` defined in `settings.ts`, imported by `runtime-flags.ts` and `agent-tool-description.ts`. `buildAgentToolDescription(mode, typeListText, compactTypeListText)` signature matches its call in `agent.ts` (A5) and its test (A3). `decideModelScope({model, modelFromParams, allowed})` matches its call (B3) and test (B2). `ModelRegistryRef` exported from `enabled-models.ts` and used in the `agent.ts` cast (B3). `ConversationViewer` 7th ctor arg `onStop?` matches the call in `commands.ts` (C2) and tests (C1). Runtime-flags getters/setters (`getScopeModels`/`setScopeModels`/`getToolDescriptionMode`/`setToolDescriptionMode`) consistent across `supervision.ts`, `agent.ts`, `commands.ts`. ✓

**Invariant check:** No feature emits `subagents:*` directly; `AgentManager.abort()` routes through the existing `AgentRun` → `external-contract-adapter` pipeline. Frontmatter authority preserved (frontmatter-pinned out-of-scope model warns, never blocks). Nerd Font glyphs untouched. ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-24-subagent-tier2-upstream-adoptions.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task (or per feature A/B/C/D/E), review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session, batch with checkpoints for review.

Which approach?
