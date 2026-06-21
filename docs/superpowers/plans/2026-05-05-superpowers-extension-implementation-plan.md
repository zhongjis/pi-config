> **SUPERSEDED (2026-06-21):** The implementation path in this plan used `/mode superpowers`. Current runtime uses Lu Ban (`/mode luban`) with `modes/luban/mode.md`; `extensions/superpowers` remains the vendored skill package. Preserve this file as historical implementation context.

# Superpowers Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `/mode superpowers` mode and a vendored `extensions/superpowers` package containing upstream Superpowers skills adapted minimally for Pi-native tools.

**Architecture:** `extensions/modes` owns mode switching and prompt injection; `agents/superpowers.md` provides the runtime Superpowers guardrail; `extensions/superpowers` packages upstream skills through `pi.skills`. Runtime bootstrap and subprocess subagent tools from `weiping/pi-superpowers` are intentionally excluded because this repo already has native `Agent` and `Task*` tools.

**Tech Stack:** TypeScript Pi extensions, Markdown agent/skill files, Vitest unit tests, package manifest `pi.skills` discovery.

---

## File Structure

Create or modify these files:

- Create: `agents/superpowers.md` — standalone Superpowers mode prompt, adapted from upstream `using-superpowers`.
- Modify: `extensions/modes/src/constants.ts` — add `superpowers`, alias `sp`, metadata, color.
- Modify: `extensions/modes/src/types.ts` — add `superpowers` to `Mode` union.
- Modify: `extensions/modes/src/commands.ts` — update CLI flag and command descriptions.
- Modify: `extensions/modes/README.md` — document `superpowers` and `sp`.
- Modify: `extensions/modes/test/mode-state.test.ts` — verify mode cycle includes `superpowers`.
- Modify: `extensions/modes/test/hooks.test.ts` — verify `superpowers` prompt marker injection.
- Create: `extensions/superpowers/package.json` — package-tier manifest with `pi.skills: ["./skills"]`.
- Create: `extensions/superpowers/README.md` — concise upstream/provenance/local behavior docs.
- Create: `extensions/superpowers/skills/**` — copy from `/tmp/obra-superpowers/skills`.
- Create: `extensions/superpowers/skills/using-superpowers/references/pi-tools.md` — Pi-native mapping reference.
- Create: `extensions/superpowers/test/manifest.test.ts` — package/skills/provenance/patch-audit tests.

Do not create `extensions/superpowers/src/`; this extension is small enough for flat package-tier layout.

---

## Task 1: Add failing Superpowers package and skill validation tests

**Files:**
- Create: `extensions/superpowers/test/manifest.test.ts`
- Test: `extensions/superpowers/test/manifest.test.ts`

- [ ] **Step 1: Write the failing manifest/skill validation test**

Create `extensions/superpowers/test/manifest.test.ts`:

```typescript
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const extensionRoot = join(process.cwd(), "extensions", "superpowers");
const skillsRoot = join(extensionRoot, "skills");

const expectedSkills = [
  "brainstorming",
  "dispatching-parallel-agents",
  "executing-plans",
  "finishing-a-development-branch",
  "receiving-code-review",
  "requesting-code-review",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development",
  "using-git-worktrees",
  "using-superpowers",
  "verification-before-completion",
  "writing-plans",
  "writing-skills",
];

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function parseFrontmatter(content: string): Record<string, string> {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n")) return {};

  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) return {};

  const frontmatter: Record<string, string> = {};
  for (const line of normalized.slice(4, endIndex).split("\n")) {
    const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (match) frontmatter[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return frontmatter;
}

function listSkillDirs(): string[] {
  return readdirSync(skillsRoot)
    .filter((name) => statSync(join(skillsRoot, name)).isDirectory())
    .sort();
}

describe("superpowers package manifest", () => {
  it("declares package skills and upstream provenance", () => {
    const manifest = readJson(join(extensionRoot, "package.json"));

    expect(manifest.pi).toEqual({
      skills: ["./skills"],
    });
    expect(manifest.piVendor).toMatchObject({
      upstream: "https://github.com/obra/superpowers",
      commit: "f2cbfbef",
      version: "5.1.0",
      localTarget: "extensions/superpowers",
    });
  });
});

describe("superpowers vendored skills", () => {
  it("vendors all expected upstream skill directories", () => {
    expect(listSkillDirs()).toEqual(expectedSkills);
  });

  for (const skillName of expectedSkills) {
    it(`${skillName} has valid frontmatter and provenance`, () => {
      const skillPath = join(skillsRoot, skillName, "SKILL.md");
      expect(existsSync(skillPath)).toBe(true);

      const content = readText(skillPath);
      const frontmatter = parseFrontmatter(content);

      expect(frontmatter.name).toBe(skillName);
      expect(frontmatter.description).toBeTruthy();
      expect(content).toContain(`https://github.com/obra/superpowers/tree/main/skills/${skillName}`);
    });
  }

  it("adds a Pi-native tool mapping reference for using-superpowers", () => {
    expect(existsSync(join(skillsRoot, "using-superpowers", "references", "pi-tools.md"))).toBe(true);
  });
});

describe("superpowers patch audit", () => {
  it("does not advertise Weiping dispatch_agent as an available tool", () => {
    const allText = expectedSkills
      .map((skillName) => readText(join(skillsRoot, skillName, "SKILL.md")))
      .join("\n");

    expect(allText).not.toContain("dispatch_agent");
  });

  it("documents Pi replacements for Claude-only Task and TodoWrite references", () => {
    const mapping = readText(join(skillsRoot, "using-superpowers", "references", "pi-tools.md"));

    expect(mapping).toContain("`Task` tool");
    expect(mapping).toContain("`Agent`");
    expect(mapping).toContain("`TodoWrite`");
    expect(mapping).toContain("`TaskCreate`");
    expect(mapping).toContain("`TaskUpdate`");
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the extension does not exist yet**

Run:

```bash
pnpm vitest run --project unit extensions/superpowers/test/manifest.test.ts
```

Expected: FAIL with an `ENOENT` or missing file error for `extensions/superpowers`.

- [ ] **Step 3: Commit failing test if this repo is using task-by-task commits**

```bash
git add extensions/superpowers/test/manifest.test.ts
git commit -m "test: specify superpowers skill package"
```

---

## Task 2: Add Superpowers package scaffold and vendor upstream skills

**Files:**
- Create: `extensions/superpowers/package.json`
- Create: `extensions/superpowers/README.md`
- Create: `extensions/superpowers/index.ts`
- Create: `extensions/superpowers/skills/**`
- Create: `extensions/superpowers/skills/using-superpowers/references/pi-tools.md`
- Test: `extensions/superpowers/test/manifest.test.ts`

- [ ] **Step 1: Copy upstream skills from the inspected upstream clone**

Run from repo root:

```bash
mkdir -p extensions/superpowers
cp -R /tmp/obra-superpowers/skills extensions/superpowers/skills
```

Expected: `extensions/superpowers/skills/using-superpowers/SKILL.md` exists.

- [ ] **Step 2: Write the package manifest**

Create `extensions/superpowers/package.json`:

```json
{
  "name": "superpowers",
  "private": true,
  "type": "module",
  "description": "Vendored Superpowers skills adapted for the local Pi harness.",
  "license": "MIT",
  "pi": {
    "extensions": ["./index.ts"],
    "skills": ["./skills"]
  },
  "piVendor": {
    "upstream": "https://github.com/obra/superpowers",
    "commit": "f2cbfbef",
    "version": "5.1.0",
    "localTarget": "extensions/superpowers",
    "adaptedFor": "panda-harness Pi mode and native Agent/Task tools"
  }
}
```

- [ ] **Step 4: Write the README**

Create `extensions/superpowers/README.md`:

```markdown
# superpowers

Vendored Superpowers skills adapted for this Pi harness, plus an opt-in `/mode superpowers` workflow.

## Upstream

- **Source:** https://github.com/obra/superpowers
- **Version:** 5.1.0
- **Commit:** f2cbfbef
- **License:** MIT
- **Adapted:** Skills keep upstream names and workflow semantics, with minimal Pi-native tool mapping notes.

## What It Does

- Ships the 14 upstream Superpowers skills under `skills/` for Pi package discovery.
- Supports the local `superpowers` mode registered by `extensions/modes`.
- Keeps Superpowers opt-in: no automatic bootstrap prompt injection outside `/mode superpowers`.

## Commands

- `/mode superpowers` — Switch to Superpowers mode.
- `/mode sp` — Short alias for Superpowers mode.

## Local Additions

- Maps upstream Claude-style tool references to Pi-native tools in `skills/using-superpowers/references/pi-tools.md`.
- Uses this repo's existing `Agent` and `Task*` tools instead of Weiping's `dispatch_agent` subprocess tool.
- Omits bootstrap injection; `extensions/modes` owns mode prompt injection.

## Notes

- Skill names remain upstream-exact for easier sync.
- `brainstorming` may be shadowed by an existing global/user skill depending Pi skill load order.

## Files Worth Reading

- `package.json` — Declares `pi.skills` and vendoring metadata.
- `skills/using-superpowers/SKILL.md` — Upstream guardrail skill, patched for Pi mapping.
- `skills/using-superpowers/references/pi-tools.md` — Pi-native tool mapping.
```

- [ ] **Step 5: Add Pi-native tool mapping reference**

Create `extensions/superpowers/skills/using-superpowers/references/pi-tools.md`:

```markdown
# Pi Tool Mapping

Superpowers upstream skills use Claude Code tool names. In this Pi harness, use these equivalents.

| Upstream reference | Pi-native replacement |
|---|---|
| `Skill` tool | Use Pi skill discovery, `/skill:<name>`, or `read` on the exact `SKILL.md` path when known. |
| `Task` tool | Use `Agent` for direct subagent launch. Use `TaskExecute` only for pi-task-backed delegation. |
| Multiple `Task` calls | Launch multiple `Agent` calls with `run_in_background: true`, one per independent workstream. |
| Task result | Use `get_subagent_result`. Use `steer_subagent` to correct a running background agent. |
| `TodoWrite` | Use `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet`. |
| `Read` | Use `read`. |
| `Write` | Use `write`. |
| `Edit` | Use `edit`. |
| `Bash` | Use `bash` with `cwd`; never write `cd dir && command`. |

Do not use Weiping's `dispatch_agent` tool in this repo. It duplicates the existing supervised `Agent` workflow.
```

- [ ] **Step 6: Add `adaptedFrom` provenance to all vendored `SKILL.md` files**

Run this one-off Node script from repo root:

```bash
node <<'NODE'
const { readdirSync, readFileSync, writeFileSync, statSync } = require('node:fs');
const { join } = require('node:path');

const skillsRoot = join(process.cwd(), 'extensions', 'superpowers', 'skills');

for (const skillName of readdirSync(skillsRoot).sort()) {
  const skillDir = join(skillsRoot, skillName);
  if (!statSync(skillDir).isDirectory()) continue;

  const skillPath = join(skillDir, 'SKILL.md');
  let content = readFileSync(skillPath, 'utf8');
  const source = `https://github.com/obra/superpowers/tree/main/skills/${skillName}`;

  if (content.includes(source)) continue;
  if (!content.startsWith('---\n')) {
    throw new Error(`${skillPath} does not start with frontmatter`);
  }

  const endIndex = content.indexOf('\n---', 4);
  if (endIndex === -1) {
    throw new Error(`${skillPath} has unterminated frontmatter`);
  }

  const before = content.slice(0, endIndex);
  const after = content.slice(endIndex);
  content = `${before}\nadaptedFrom:\n  - "${source}"${after}`;
  writeFileSync(skillPath, content);
}
NODE
```

Expected: every `extensions/superpowers/skills/*/SKILL.md` contains its upstream source URL.

- [ ] **Step 7: Apply narrow Pi wording patches to `using-superpowers/SKILL.md`**

Modify `extensions/superpowers/skills/using-superpowers/SKILL.md` only in sections that name platform tools. Replace its "How to Access Skills" and tool-mapping paragraph with:

```markdown
## How to Access Skills

**In Pi:** Skills are listed in the system prompt by name and description. When a skill might apply, load the current `SKILL.md` with `read` if the path is known, or use `/skill:<name>` when operating interactively. Do not rely on memory; skills change.

**Tool mapping:** Upstream Superpowers skills use Claude Code tool names. In this Pi harness, use `references/pi-tools.md` for equivalents.
```

Then update the flow labels in the same file:

```markdown
"Invoke Skill tool" -> "Load matching SKILL.md"
"Create TodoWrite todo per item" -> "Create pi-task per checklist item"
"Follow skill exactly" stays unchanged.
```

Expected: `using-superpowers/SKILL.md` points to `references/pi-tools.md` and no longer instructs users to use Claude/Copilot/Gemini activation tools as the primary path.

- [ ] **Step 8: Apply narrow Pi wording patches to subagent prompt templates**

Patch only the first `Task tool (...)` heading in these files:

- `extensions/superpowers/skills/brainstorming/spec-document-reviewer-prompt.md`
- `extensions/superpowers/skills/requesting-code-review/code-reviewer.md`
- `extensions/superpowers/skills/subagent-driven-development/implementer-prompt.md`
- `extensions/superpowers/skills/subagent-driven-development/spec-reviewer-prompt.md`
- `extensions/superpowers/skills/subagent-driven-development/code-quality-reviewer-prompt.md`
- `extensions/superpowers/skills/writing-plans/plan-document-reviewer-prompt.md`

Use this replacement pattern:

```markdown
Pi `Agent` tool:
```

Keep the rest of each template intact, except where it explicitly says `Task tool` as the callable tool name.

- [ ] **Step 9: Run manifest tests and fix only failures caused by scaffold/provenance/mapping**

Run:

```bash
pnpm vitest run --project unit extensions/superpowers/test/manifest.test.ts
```

Expected: PASS.

- [ ] **Step 10: Run root extension smoke test**

At this stage `extensions/superpowers/` contains the package manifest and skills but not yet an `index.ts` (added in Task 3). The smoke test discovers entrypoints by `index.ts`, so it temporarily skips this package and still passes. Confirm:

```bash
pnpm vitest run --project unit test/extensions.smoke.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit scaffold and vendored skills**

```bash
git add extensions/superpowers
git commit -m "feat: vendor superpowers skills package"
```

---

## Task 3: Add extension `index.ts` that injects bundled skills via `resources_discover`

**Why:** `pi.skills` in `package.json` is honored only for packages installed through `pi install`. For symlink-deployed local extensions, Pi's auto-discovery never reads `pi.skills`, so the bundled skills are invisible without a `resources_discover` event handler. This is the documented Pi extension API for injecting skill paths.

**Files:**
- Create: `extensions/superpowers/index.ts`
- Create: `extensions/superpowers/test/index.test.ts`
- Test: `extensions/superpowers/test/index.test.ts`

- [ ] **Step 1: Write `index.ts`**

```typescript
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const baseDir = dirname(fileURLToPath(import.meta.url));

export default function superpowersExtension(pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: [join(baseDir, "skills")],
  }));
}
```

Pattern matches Pi's official `dynamic-resources` example (`pi-coding-agent/examples/extensions/dynamic-resources/index.ts`).

- [ ] **Step 2: Write the direct test**

Create `extensions/superpowers/test/index.test.ts`:

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import superpowersExtension from "../index.js";

describe("superpowers extension", () => {
  it("registers a resources_discover handler that points at the bundled skills dir", async () => {
    const mock = createMockPi();
    superpowersExtension(mock.pi as never);

    const handlers = mock.lifecycleHandlers.get("resources_discover");
    expect(handlers).toBeDefined();
    expect(handlers?.length).toBe(1);

    const result = (await handlers?.[0]?.({ cwd: process.cwd(), reason: "startup" }, {})) as {
      skillPaths: string[];
    };

    expect(result.skillPaths).toHaveLength(1);
    const skillsPath = result.skillPaths[0];
    expect(skillsPath).toMatch(/extensions\/superpowers\/skills$/);
    expect(existsSync(skillsPath)).toBe(true);
    expect(existsSync(join(skillsPath, "using-superpowers", "SKILL.md"))).toBe(true);
  });
});
```

- [ ] **Step 3: Run focused tests**

```bash
pnpm vitest run --project unit extensions/superpowers/test/index.test.ts test/extensions.smoke.test.ts
```

Expected: PASS. Smoke test now picks up `extensions/superpowers/index.ts` again.

- [ ] **Step 4: Commit**

```bash
git add extensions/superpowers/index.ts extensions/superpowers/test/index.test.ts
git commit -m "feat(superpowers): inject bundled skills via resources_discover"
```

---

## Task 4: Add `superpowers` mode registration tests and constants

**Files:**
- Modify: `extensions/modes/src/constants.ts`
- Modify: `extensions/modes/src/types.ts`
- Modify: `extensions/modes/src/commands.ts`
- Modify: `extensions/modes/test/mode-state.test.ts`
- Modify: `extensions/modes/test/hooks.test.ts`
- Test: `extensions/modes/test/mode-state.test.ts`
- Test: `extensions/modes/test/hooks.test.ts`

- [ ] **Step 1: Update the mode cycle test first**

Modify `extensions/modes/test/mode-state.test.ts` in the `cycles through modes` test. Replace this setup and expectation block:

```typescript
state.cachedConfigs.kuafu = { body: "" };
state.cachedConfigs.fuxi = { body: "" };
state.cachedConfigs.houtu = { body: "" };
```

with:

```typescript
state.cachedConfigs.kuafu = { body: "" };
state.cachedConfigs.fuxi = { body: "" };
state.cachedConfigs.houtu = { body: "" };
state.cachedConfigs.superpowers = { body: "" };
```

Replace the assertions at the end of the same test with:

```typescript
expect(state.currentMode).toBe("kuafu");
await state.cycleMode(ctx as never);
expect(state.currentMode).toBe("fuxi");
await state.cycleMode(ctx as never);
expect(state.currentMode).toBe("houtu");
await state.cycleMode(ctx as never);
expect(state.currentMode).toBe("superpowers");
await state.cycleMode(ctx as never);
expect(state.currentMode).toBe("kuafu");
```

- [ ] **Step 2: Add a hook test for Superpowers prompt marker injection**

Append this test to `extensions/modes/test/hooks.test.ts` inside `describe("mode hooks", () => { ... })`:

```typescript
it("injects superpowers prompt with HTML markers", async () => {
  const mock = createMockPi();
  const state = new ModeStateManager(mock.pi as never);
  state.currentMode = "superpowers";
  state.cachedConfigs.superpowers = { body: "Superpowers prompt", promptMode: "replace" };

  registerModeHooks(mock.pi as never, state);

  const [result] = await mock.fire("before_agent_start", { systemPrompt: "Base prompt" }, { hasUI: false });

  expect(result).toEqual({
    systemPrompt: "Base prompt\n\n<!-- mode:superpowers -->\nSuperpowers prompt\n<!-- /mode:superpowers -->",
  });
});
```

- [ ] **Step 3: Run mode tests and verify they fail before production changes**

Run:

```bash
pnpm vitest run --project unit extensions/modes/test/mode-state.test.ts extensions/modes/test/hooks.test.ts
```

Expected: FAIL with TypeScript or runtime errors because `superpowers` is not in `Mode` yet.

- [ ] **Step 4: Update mode type union**

Modify `extensions/modes/src/types.ts` line 1 from:

```typescript
export type Mode = "kuafu" | "fuxi" | "houtu";
```

to:

```typescript
export type Mode = "kuafu" | "fuxi" | "houtu" | "superpowers";
```

- [ ] **Step 5: Update mode constants**

Modify `extensions/modes/src/constants.ts` to this exact mode block:

```typescript
import type { Mode } from "./types.js";

export const MODES: Mode[] = ["kuafu", "fuxi", "houtu", "superpowers"];

export const MODE_ALIASES: Record<string, Mode> = {
	build: "kuafu",
	plan: "fuxi",
	execute: "houtu",
	sp: "superpowers",
};

export const MODE_META: Record<Mode, { alias: string; label: string }> = {
	kuafu: { alias: "build", label: "Kua Fu 夸父 (build)" },
	fuxi: { alias: "plan", label: "Fu Xi 伏羲 (plan)" },
	houtu: { alias: "execute", label: "Hou Tu 后土 (execute)" },
	superpowers: { alias: "sp", label: "Superpowers (skills)" },
};

// Color scheme (24-bit ANSI)
export const MODE_COLORS: Record<Mode, string> = {
	kuafu: "\x1b[38;2;0;206;209m", // #00CED1 — dark turquoise (夸父)
	fuxi: "\x1b[38;2;255;87;34m", // #FF5722 — deep orange/fire (伏羲)
	houtu: "\x1b[38;2;16;185;129m",
	superpowers: "\x1b[38;2;168;85;247m", // #A855F7 — purple (Superpowers)
};
```

Keep the existing `RESET`, `PLAN_FILE_NAME`, `LOCAL_PLAN_URI`, `DRAFT_FILE_NAME`, and `LOCAL_DRAFT_URI` lines below this block unchanged.

- [ ] **Step 6: Update mode command descriptions**

Modify `extensions/modes/src/commands.ts` descriptions:

```typescript
description: "Agent mode: kuafu (build), fuxi (plan), houtu (execute), superpowers (sp)",
```

and:

```typescript
description: "Switch agent mode (kuafu/fuxi/houtu/superpowers)",
```

Do not change command behavior; aliases already come from `MODE_ALIASES`.

- [ ] **Step 7: Run mode tests**

Run:

```bash
pnpm vitest run --project unit extensions/modes/test/mode-state.test.ts extensions/modes/test/hooks.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit mode registration**

```bash
git add extensions/modes/src/constants.ts extensions/modes/src/types.ts extensions/modes/src/commands.ts extensions/modes/test/mode-state.test.ts extensions/modes/test/hooks.test.ts
git commit -m "feat: register superpowers mode"
```

---

## Task 5: Add standalone Superpowers mode prompt

**Files:**
- Create: `agents/superpowers.md`
- Test: `extensions/modes/test/hooks.test.ts`

- [ ] **Step 1: Write `agents/superpowers.md`**

Create `agents/superpowers.md`:

```markdown
---
display_name: Superpowers
description: Superpowers discipline mode. Loads relevant skills before acting, follows skill workflows exactly, and maps upstream Superpowers tool references to Pi-native Agent and Task tools.
model: anthropic/claude-sonnet-4-6:medium,openai-codex/gpt-5.5:medium
prompt_mode: replace
inherit_context: false
builtin_tools: read,bash,edit,write,grep,find,ls
extension_tools: ask,readonly_bash,lsp_diagnostics,web_search,code_search,fetch_content,get_search_content,mcporter,mcp,Agent,get_subagent_result,steer_subagent,TaskCreate,TaskList,TaskGet,TaskUpdate,TaskOutput,TaskStop,TaskExecute,plan_approve
allow_delegation_to: chengfeng,wenchang,jintong,yunu,guangguang,taishang,fuxi
allow_nesting: true
---

<role>
You are Superpowers mode — an opt-in discipline mode adapted from obra/superpowers for this Pi harness.
</role>

<critical>
Before any response, check whether a relevant skill exists. If any skill might apply, read that skill first, announce it briefly, then follow it.

No rationalizing around this rule:
- "This is simple" is not an excuse.
- "I need to inspect files first" is not an excuse; skills tell you how to inspect.
- "I remember the skill" is not enough; read the current skill.
- Clarifying questions still require the skill check first.
</critical>

<procedure>
## Skill gate

For every user request:
1. Identify likely relevant skills from the available skill list.
2. If one or more skills might apply, load the most relevant `SKILL.md` before acting.
3. Say: `I'm using the <skill-name> skill to <purpose>.`
4. If the loaded skill has a checklist, create pi-tasks for checklist items with `TaskCreate` / `TaskUpdate` unless the task is trivial and the skill says otherwise.
5. Follow the skill workflow exactly.
6. If no skill applies, proceed normally and keep changes minimal.

## Pi tool mapping for Superpowers skills

Upstream Superpowers skills use Claude Code tool names. In this harness:
- `Skill` tool → read the matching `SKILL.md` when path is known, or use `/skill:<name>` interactively.
- `Task` tool → use `Agent` for direct subagent launch.
- Multiple `Task` calls → launch multiple `Agent` calls with `run_in_background: true` only when workstreams are independent.
- Task result → use `get_subagent_result`; steer with `steer_subagent` if needed.
- `TodoWrite` → use `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet`.
- `Read` / `Write` / `Edit` / `Bash` → use Pi `read`, `write`, `edit`, `bash`.
- For `bash`, always set `cwd`; never write `cd dir && command`.

Do not use Weiping's `dispatch_agent` pattern. This repo already has supervised `Agent` tooling.

## Execution stance

- Do not implement during brainstorming or planning unless the skill and user both authorize implementation.
- Use TDD when `test-driven-development` applies.
- For multi-step implementation, prefer `subagent-driven-development` or the repo's existing plan/execution modes.
- For code changes, verify before completion: diagnostics, focused tests, build/typecheck when relevant, manual readback.
- Preserve upstream vendored skill text unless Pi tool mismatch requires a minimal patch.
</procedure>
```

- [ ] **Step 2: Run the prompt injection test**

Run:

```bash
pnpm vitest run --project unit extensions/modes/test/hooks.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit the mode prompt**

```bash
git add agents/superpowers.md
git commit -m "feat: add superpowers mode prompt"
```

---

## Task 6: Document Superpowers mode in modes README

**Files:**
- Modify: `extensions/modes/README.md`
- Test: manual readback

- [ ] **Step 1: Update the mode summary table**

Modify `extensions/modes/README.md` table to include Superpowers:

```markdown
| Mode | Alias | Description |
|------|-------|-------------|
| Kua Fu 夸父 | `build` | Default. Senior engineer who ships by orchestrating specialists. |
| Fu Xi 伏羲 | `plan` | Planning and decomposition. Drafts plans with gap review. |
| Hou Tu 后土 | `execute` | Focused execution worker. Runs plans step by step. |
| Superpowers | `sp` | Skill-first discipline mode adapted from obra/superpowers. |
```

- [ ] **Step 2: Update the mode count sentence**

Change:

```markdown
Agent modes extension with three personas — switch behavior, prompt, and tool sets per mode.
```

to:

```markdown
Agent modes extension with four personas — switch behavior, prompt, and tool sets per mode.
```

Change:

```markdown
Three modes with distinct agent personas:
```

to:

```markdown
Four modes with distinct agent personas:
```

- [ ] **Step 3: Update the commands section**

Change:

```markdown
- `/mode [kuafu|fuxi|houtu|build|plan|execute]` — Switch agent mode
```

to:

```markdown
- `/mode [kuafu|fuxi|houtu|superpowers|build|plan|execute|sp]` — Switch agent mode
```

- [ ] **Step 4: Read back the README and verify it mentions Superpowers once in each relevant section**

Run:

```bash
rg -n "Superpowers|superpowers|sp" extensions/modes/README.md
```

Expected: output includes the summary table row and command syntax.

- [ ] **Step 5: Commit docs update**

```bash
git add extensions/modes/README.md
git commit -m "docs: document superpowers mode"
```

---

## Task 7: Final patch audit, typecheck, and focused verification

**Files:**
- Read/verify: all changed files
- Test: focused extension and typecheck commands

- [ ] **Step 1: Run exact patch-audit searches**

Run:

```bash
rg -n "dispatch_agent|pi install npm" extensions/superpowers agents/superpowers.md extensions/modes/README.md
```

Expected: no output, except README/spec text if implementation intentionally documents a negative policy. If output appears in a vendored skill as an available tool or install instruction, patch it.

Run:

```bash
rg -n "Task tool|TodoWrite|Skill tool|SessionStart|Claude Code" extensions/superpowers/skills
```

Expected: only acceptable contexts remain:

- upstream history/reference text with nearby Pi mapping;
- `references/pi-tools.md` mapping table;
- negative or explanatory text, not instructions to use unavailable tools directly.

- [ ] **Step 2: Run all focused unit tests**

Run:

```bash
pnpm vitest run --project unit extensions/superpowers/test/manifest.test.ts extensions/modes/test/mode-state.test.ts extensions/modes/test/hooks.test.ts test/extensions.smoke.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run extension test suite**

Run:

```bash
pnpm test:extensions
```

Expected: PASS.

- [ ] **Step 4: Run typecheck/lint wrapper**

Run:

```bash
pnpm lint:typecheck
```

Expected: PASS.

- [ ] **Step 5: Manual readback checklist**

Read these files and confirm they match the spec:

```text
agents/superpowers.md
extensions/modes/src/constants.ts
extensions/modes/src/types.ts
extensions/modes/src/commands.ts
extensions/modes/README.md
extensions/superpowers/index.ts
extensions/superpowers/package.json
extensions/superpowers/test/index.test.ts
extensions/superpowers/README.md
extensions/superpowers/skills/using-superpowers/SKILL.md
extensions/superpowers/skills/using-superpowers/references/pi-tools.md
```

Expected:

- `superpowers` mode uses `prompt_mode: replace`.
- `sp` alias exists.
- `extensions/superpowers/package.json` declares `pi.extensions: ["./index.ts"]` and `pi.skills: ["./skills"]`.
- `extensions/superpowers/index.ts` registers `resources_discover` returning the absolute `skills/` path.
- no bootstrap hook exists.
- no `dispatch_agent` tool exists.
- upstream skill names remain unchanged.

- [ ] **Step 7: Commit final verification fixes if any**

If verification required small fixes:

```bash
git add agents/superpowers.md extensions/modes extensions/superpowers
git commit -m "fix: polish superpowers integration"
```

If no fixes were needed, skip this commit.

---

## Self-Review

### Spec coverage

- Opt-in `/mode superpowers`: Tasks 4, 5, and 6.
- Vendored upstream skills: Task 2.
- Minimal Pi-native patching: Task 2, Steps 5-8, plus Task 7 audit.
- No Weiping bootstrap or subprocess runtime: Task 2 README and Task 7 audit.
- Package manifest skill discovery: Tasks 1 and 2.
- Skill injection via `resources_discover`: Task 3 (extension `index.ts` ensures bundled skills are discoverable in symlink-deployed setups).
- Skill collision stance: Task 2 README.
- `using-superpowers` sync relationship: Task 2 README plus Task 5 mode prompt.
- Validation: Task 7.

### Placeholder scan

Plan text contains no unresolved placeholders. Every created TypeScript, JSON, Markdown, and command snippet is specified.

### Type consistency

- Mode name is consistently `superpowers`.
- Alias is consistently `sp`.
- Package path is consistently `extensions/superpowers`.
- Upstream commit is consistently `f2cbfbef`.
- Version is consistently `5.1.0`.
- Pi tool replacements consistently use `Agent`, `get_subagent_result`, `steer_subagent`, `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet`.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-05-superpowers-extension-implementation-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
