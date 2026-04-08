# Agent Modes v2: Multi-Persona System for Pi

## TL;DR

Build a `modes.ts` extension that gives pi three personas — Sisyphus (build), Prometheus (plan), Atlas (execute) — each with distinct tools, prompts, and pi-tasks workflows. Default startup mode is **Sisyphus** (general build). All personas share AGENTS.md global rules, reuse `agents/*.md` for persona prompts, and have access to pi-tasks + existing subagents. Plans are stored in the session via `pi.appendEntry()` — no filesystem scratch space.

Inspired by [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent), adapted for pi's extension architecture. Single-session personality swapping (not separate processes).

## Context

### What Exists

| Piece | Location | Status |
|-------|----------|--------|
| 4 subagents (lookout, oracle, scout, prometheus) | `agents/*.md` | ✅ |
| pi-subagents extension (`Agent`, `get_subagent_result`, `steer_subagent`) | `extensions/subagent/` | ✅ |
| pi-tasks extension (structured task tracking) | `extensions/pi-tasks/` | ✅ |
| AGENTS.md (global rules) | `AGENTS.md` | ✅ |
| plan-mode/preset.ts examples | pi repo `examples/extensions/` | reference only |

### What This Plan Creates

| Deliverable | Path |
|-------------|------|
| Mode switcher extension | `extensions/modes.ts` |
| Sisyphus agent definition | `agents/sisyphus.md` (NEW) |
| Atlas agent definition | `agents/atlas.md` (NEW) |

No `modes/*.md` directory — persona prompts live in `agents/*.md` and are read at runtime by the extension.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  pi starts → Sisyphus mode (default)                 │
│                                                      │
│  AGENTS.md (global rules — always active)            │
│  + agents/<mode>.md prompt injection (read at runtime)│
│  + mode-specific tool restrictions                   │
│                                                      │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐     │
│  │ SISYPHUS  │  │ PROMETHEUS │  │    ATLAS     │     │
│  │  (build)  │  │  (plan)    │  │  (execute)   │     │
│  │           │  │            │  │              │     │
│  │ DEFAULT   │  │ read-only  │  │ plan-driven  │     │
│  │ all tools │  │ read tools │  │ all tools    │     │
│  │ pi-tasks: │  │ pi-tasks:  │  │ pi-tasks:    │     │
│  │ on-demand │  │ planning   │  │ tracking     │     │
│  │           │  │ flow       │  │ progress     │     │
│  └─────┬─────┘  └─────┬──────┘  └──────┬───────┘     │
│        │              │               │              │
│        └──── subagents at disposal ───┘              │
│        lookout · oracle · scout · prometheus          │
└──────────────────────────────────────────────────────┘
```

### Key Design Decision: Mode = Personality Swap, Not Process Spawn

The primary agent stays in the same session. Mode switching swaps:
- System prompt injection (via `before_agent_start`)
- Active tool set (via `pi.setActiveTools()`)
- Behavioral expectations

Benefits over oh-my-openagent's approach:
- Prometheus sees conversation history → no context serialization
- Atlas sees what Prometheus planned → seamless transition
- No token overhead from process spawning for the primary persona

---

## Mode Definitions

### 1. Sisyphus (Build Mode) — DEFAULT ON STARTUP

**Prompt source**: `agents/sisyphus.md` (NEW — to be created)

**Identity** (adapted from oh-my-openagent):

> You are Sisyphus — a senior engineer who ships. You work directly, delegate when specialists are available, and verify everything. You follow existing codebase patterns. You never stop until the task is done.

**Tools**: all (read, bash, edit, write, grep, find, ls, Agent, get_subagent_result, steer_subagent) + pi-tasks

**Pi-tasks usage — on-demand for medium/complex work**:

Sisyphus doesn't always use tasks. The rule:
- **Trivial** (single file, obvious change): just do it.
- **Medium** (2-4 files, multi-step): create tasks, track progress.
- **Complex** (5+ files, architectural): should probably be in Prometheus first, but if user insists, create detailed tasks.

**Subagent access**:
- `lookout` — fast codebase exploration
- `scout` — web research
- `oracle` — architecture consultation
- `prometheus` — if Sisyphus decides the task needs a plan first, it can delegate to prometheus subagent

**Key behavioral rules** (from oh-my-openagent Sisyphus):
- Intent gate: classify every message (trivial/explicit/exploratory/open-ended/ambiguous).
- Default bias: delegate to subagents when specialists are available.
- Verify after changes: lsp_diagnostics on changed files, run tests if available.
- Failure recovery: fix root causes, not symptoms. After 3 failures, stop and reconsider.
- Be concise: no preamble, no flattery, no status updates. Just work.
- Challenge user when their approach seems problematic.
- Match user's communication style.

---

### 2. Prometheus (Plan Mode)

**Prompt source**: `agents/prometheus.md` (existing — already well-defined)

**Identity** (adapted from oh-my-openagent):

> You are Prometheus — a strategic planning consultant. You plan. You do not implement. When the user says "do X", interpret it as "create a plan for X". No exceptions.

**Tools**: `read`, `grep`, `find`, `ls`, `bash` (read-only enforced), `Agent`, `get_subagent_result`, `steer_subagent`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`

**Blocked tools**: `edit`, `write`

**Bash policy**: allowlist of read-only commands only (same as existing plan-mode extension)

**Pi-tasks usage — fixed planning flow**:

When Prometheus begins planning, it follows a structured task sequence:

```
1. Classify intent (trivial / build / refactor / architecture)
2. Research codebase (use lookout/scout subagents for recon)
3. Interview user (ask clarifying questions if needed — skip for trivial)
4. Generate plan (numbered steps with file paths, risks, verification)
5. Write plan via `plan_write` tool (stored as session entry)
6. Present summary + prompt user: Execute? / Refine? / Stay in plan mode?
```

Prometheus should create these as pi-tasks at the start of every planning session to track its own progress. This makes the planning flow visible and resumable.

**Subagent access**:
- `lookout` — fast codebase exploration
- `scout` — web research, docs, external patterns
- `oracle` — architecture consultation (for complex/architecture intents)

**Key behavioral rules** (from oh-my-openagent Prometheus):
- Interview before planning. Don't assume.
- Self-clearance check: all requirements clear before generating plan.
- Single plan mandate: everything goes into ONE plan file, no matter how large.
- Classify gaps: critical (ask user), minor (self-resolve), ambiguous (apply default + disclose).
- Plan must maximize parallel execution. One task = one module/concern = 1-3 files.
- Include dependency graph and parallel execution waves in plan.
- Each plan step must name specific files, functions, and concrete checks.
- Include a `Verify:` section with concrete post-completion checks.

**Post-plan prompt** (interactive UI):
After agent_end in Prometheus mode, if a plan was generated:
```
"Plan ready. What next?"
→ Execute the plan (switch to Atlas)
→ Stay in plan mode
→ Refine the plan
```

**Exit**: user chooses "Execute" → mode switches to Atlas with plan loaded.

---

### 3. Atlas (Execute Mode)

**Prompt source**: `agents/atlas.md` (NEW — to be created)

**Identity** (adapted from oh-my-openagent):

> You are Atlas — the master conductor. You hold up the entire workflow. You coordinate, delegate, and verify. You execute the plan step by step. You are relentless — you do not stop until every task is complete or explicitly blocked.

**Tools**: all (read, bash, edit, write, grep, find, ls, Agent, get_subagent_result, steer_subagent) + pi-tasks

**Pi-tasks usage — progress tracking**:

Atlas receives the plan via injection from the extension (see Plan Handoff section). It creates pi-tasks for each step. As it works:
- Mark tasks `in_progress` before starting each step
- Mark tasks `completed` after verification passes
- Widget shows progress: `☑ Step 1  ☐ Step 2  ☐ Step 3`

**Subagent access**:
- `lookout` — quick recon during execution
- `scout` — research when hitting unknowns
- `oracle` — consult on complex decisions mid-execution

**Key behavioral rules** (from oh-my-openagent Atlas):
- Auto-continue: never ask "should I continue?" between plan steps. Just proceed.
- After each step: verify (lsp_diagnostics, tests if applicable, read changed files).
- Evidence required: no evidence = not complete.
- If verification fails: fix, don't skip.
- After 3 consecutive failures on one step: stop, document, ask user.
- Cross-check: what you claimed vs what the code actually does.
- When all steps complete: generate completion summary, return to Sisyphus mode.

**Post-completion**: all tasks done → summary report → mode switches to Sisyphus.

---

## Prompt Layer Architecture

```
System Prompt (built by pi):
  └── AGENTS.md (global rules — always loaded by pi automatically)
       └── Mode-specific injection (via before_agent_start):
            ├── reads agents/sisyphus.md    → injects body as prompt
            ├── reads agents/prometheus.md  → injects body as prompt
            └── reads agents/atlas.md       → injects body as prompt
```

AGENTS.md = global rules (code quality, shell safety, enterprise strategy). Always active.
agents/<mode>.md = persona prompt. Injected only when that mode is active.

The extension reads the `.md` file body (after frontmatter) at mode switch time and caches it.
On `before_agent_start`, it appends the cached prompt to `event.systemPrompt`.

---

## Extension Design: `modes.ts`

### Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerCommand("mode", ...)` | `/mode`, `/mode prometheus`, `/mode atlas`, `/mode sisyphus` |
| `pi.registerFlag("mode", ...)` | `--mode prometheus` from CLI (default: sisyphus) |
| `pi.registerShortcut(Key.ctrlShift("m"), ...)` | Cycle modes |
| `pi.setActiveTools(...)` | Restrict tools per mode |
| `pi.on("before_agent_start", ...)` | Inject mode-specific prompt (from agents/*.md) |
| `pi.on("tool_call", ...)` | Block destructive bash in Prometheus mode |
| `pi.on("agent_end", ...)` | Post-plan UI prompt in Prometheus; completion handler in Atlas |
| `pi.on("context", ...)` | Filter stale mode context messages when switching |
| `pi.appendEntry(...)` | Persist mode + active plan across session resume |
| `ctx.ui.setStatus(...)` | Footer: colored `sisyphus` (#00CED1) / `prometheus` (#FF5722) / `atlas` (#10B981) |
| `ctx.ui.setWidget(...)` | Plan progress in Atlas mode |
| `ctx.ui.select(...)` | Post-plan action prompt |
| `pi.on("session_start", ...)` | Restore mode from session; default to sisyphus |

### Prompt Loading

The extension uses `parseFrontmatter()` from pi-coding-agent (same as subagent/agents.ts) to read agent `.md` files. It extracts the body (after frontmatter) and injects it as the mode prompt.

```typescript
// At mode switch or session_start:
const content = fs.readFileSync(path.join(agentDir, 'agents', `${mode}.md`), 'utf-8');
const { body } = parseFrontmatter(content);
cachedPrompt = body;

// In before_agent_start:
return { systemPrompt: event.systemPrompt + '\n\n' + cachedPrompt };
```

### Mode State

```typescript
interface ModeState {
  mode: "prometheus" | "atlas" | "sisyphus";
  activePlan?: string;  // plan title, e.g. "AUTH_REFACTOR"
  planTitle?: string;
}
```

Persisted via `pi.appendEntry("agent-mode", state)` and restored in `session_start`.

### Startup Behavior

1. Check `--mode` flag → use if provided
2. Check persisted mode from session → use if resuming
3. Default → `sisyphus`

### Mode Transitions

```
prometheus → atlas    (user: "Execute the plan" after plan generation)
prometheus → sisyphus (user: /mode sisyphus)
atlas → sisyphus      (automatic: all tasks complete)
atlas → prometheus    (user: /mode prometheus — rare, for replanning)
sisyphus → prometheus (user: /mode prometheus or /mode plan)
sisyphus → atlas      (user: /mode atlas <plan-name>)
any → any             (user: /mode <name>)
```

### Command: `/mode`

```
/mode              → show current mode + selector to switch
/mode prometheus   → switch to prometheus
/mode atlas        → switch to atlas (optionally: /mode atlas AUTH_REFACTOR)
/mode sisyphus     → switch to sisyphus
/mode plan         → alias for prometheus
/mode build        → alias for sisyphus
/mode execute      → alias for atlas
```

---

## Mode Prompt Content

Prompts live in `agents/*.md`. The extension reads them at runtime.

### agents/sisyphus.md (NEW)

Key sections to include:

1. **Identity**: "You are Sisyphus — a senior engineer who ships."
2. **Intent gate**: classify every message, route appropriately.
3. **Task usage**: create pi-tasks for medium+ complexity work.
4. **Delegation**: default bias toward delegation when specialists available.
5. **Verification**: lsp_diagnostics, tests, evidence-based completion.
6. **Communication**: concise, no flattery, no preamble. Challenge bad ideas.

### agents/prometheus.md (EXISTS)

Already well-defined. Key sections already present:

1. Identity as strategic planner
2. Request interpretation ("do X" → "plan X")
3. Interview mode, self-clearance check
4. Plan output, gap classification
5. Subagent delegation (lookout, scout, oracle)
6. exit_plan_mode tool integration

May need minor updates to reference `plan_write`/`plan_read` tools and pi-tasks planning flow.

### agents/atlas.md (NEW)

Key sections to include:

1. **Identity**: "You are Atlas — master conductor. You coordinate, delegate, verify."
2. **Auto-continue**: never ask permission between steps. Execute and verify.
3. **Pi-tasks integration**: create tasks from plan steps, track progress.
4. **Verification protocol**: after each step, run checks. Read changed files. Cross-check claims.
5. **Failure handling**: retry up to 3 times, then stop and report.
6. **Completion**: when all tasks done, summarize and return to Sisyphus mode.

---

## Plan Storage & Handoff

Plans are stored **inside the session** via `pi.appendEntry()` — no filesystem scratch space needed.

**Why session storage:**
- Plans are session state, not project state
- No filesystem pollution (no `.pi/artifacts/`, no project root files)
- Survives compaction if stored as custom entries
- Portable — plan lives wherever the session lives (`~/.pi/agent/sessions/`)
- Forking a session forks the plan too

### Writing: `plan_write` tool

- Parameters: `{ content: string }` — the full plan markdown
- Stores via `pi.appendEntry("plan", { content, draft: true })`
- Only available in Prometheus mode
- Agent writes to it like `plan_write({ content: "# Auth Refactor\n..." })`

### Finalizing: `exit_plan_mode` tool

- Parameters: `{ title: string }` — e.g. `"AUTH_REFACTOR"`
- Finalizes: `pi.appendEntry("plan", { title, content, draft: false })`
- Triggers the post-plan UI prompt (Execute? / Refine? / Stay?)

### Handoff: Prometheus → Atlas (injection, not fetching)

**Problem with a `plan_read` tool:**
1. **Duplicate context.** The planning conversation is already in session history. Atlas sees all of it. If Atlas then calls `plan_read`, the plan exists twice in context — once in conversation, once in tool result. Waste of tokens.
2. **Only needed post-compaction.** After compaction, planning history gets summarized away and Atlas would need the plan re-injected. But that's the recovery case, not the common path.

**Solution: the extension injects the plan on mode switch.**

When switching Prometheus → Atlas, the `modes.ts` extension:

```typescript
// In before_agent_start, when mode just switched to Atlas:
return {
  message: {
    customType: "plan-context",
    content: `[ACTIVE PLAN: ${title}]\n\n${planContent}`,
    display: true,
  },
};
```

Then in the `context` event, optionally strip Prometheus noise (planning tasks, interview Q&A) so Atlas gets a clean context with just the plan.

**No `plan_read` tool in the normal flow.** Atlas doesn't need to fetch what the extension already injected.

**`plan_read` as fallback only:**
- Registered but not needed in the happy path
- Useful post-compaction (plan conversation summarized away, entry still in session)
- Useful if someone enters Atlas mode manually without coming from Prometheus
- Available in all modes

### Context cleanup on mode switch

The `context` event handler can strip stale planning conversation when Atlas is active:
- Remove messages with `customType: "plan-mode-context"` (Prometheus-injected interview context)
- Optionally trim Prometheus planning tasks and interview back-and-forth
- Keep the `plan-context` injection message (Atlas needs it)
- This gives Atlas a clean starting context: the plan + any user preamble, without the planning noise

**Plan format** (simplified from oh-my-openagent):

```markdown
# <Plan Title>

## Context
<What we're trying to do and why>

## Scope
- IN: <what's included>
- OUT: <what's excluded>

## Assumptions
- <any assumptions made>

## Plan
1. <Step with specific file/function>
2. <Step with specific file/function>
3. ...

## Risks
- <risk 1>
- <risk 2>

## Verify
- <concrete check 1>
- <concrete check 2>
```
---

## Implementation Steps

### Phase 1: Core Extension (MVP)

1. Create `agents/sisyphus.md` — build persona prompt (adapt from oh-my-openagent Sisyphus)
2. Create `agents/atlas.md` — execution persona prompt (adapt from oh-my-openagent Atlas)
3. Update `agents/prometheus.md` — minor: reference `plan_write` tool for plan output, add pi-tasks planning flow guidance
4. Create `extensions/modes.ts` with:
   - Mode state management (sisyphus/prometheus/atlas)
   - `/mode` command + `--mode` flag + `Ctrl+Shift+M` shortcut
   - Reads persona prompt from `agents/<mode>.md` at runtime
   - Tool restriction per mode (prometheus: read-only)
   - Prompt injection via `before_agent_start`
   - Bash allowlist enforcement for Prometheus
   - Session persistence of mode state
   - Footer status indicator
   - Default to Sisyphus on startup

### Phase 2: Mode Transitions

5. Prometheus → Atlas transition (post-plan "Execute" action via `agent_end` + `ctx.ui.select`)
6. Atlas → Sisyphus transition (automatic: all plan tasks complete)
7. Context filtering (remove stale mode context messages on switch)

### Phase 3: Polish

8. Atlas progress widget (pi-tasks integration for visual progress)
9. Plan loading for Atlas mode (`/mode atlas AUTH_REFACTOR` reads titled plan from session)

### Phase 4: Later Additions (NOT in v1)

- Auto-mode detection ("plan X" → auto Prometheus, "fix X" → auto Sisyphus)
- Model per mode (different models for different personas)
- Wisdom accumulation (Atlas writes learnings for subsequent tasks)
- Worker subagent (for Atlas to delegate isolated implementation tasks)

---

## Risks

1. **Prompt length**: persona prompts + AGENTS.md could be large. Mitigation: keep persona prompts focused, ~500-800 tokens each. AGENTS.md is already loaded; persona prompts add to it, not duplicate.

2. **Mode confusion**: LLM might drift from persona mid-conversation. Mitigation: strong identity statements at top of prompt, tool restrictions as hard guardrails.

3. **Pi-tasks coupling**: pi-tasks is a third-party extension. Mitigation: modes.ts guides the LLM to use tasks via prompt, doesn't call pi-tasks APIs directly. Degrades gracefully if not installed.

4. **Agent file coupling**: modes.ts reads from `agents/`. If user renames or deletes an agent file, mode breaks. Mitigation: fallback to empty prompt with a warning notification.

---

## Verify

After implementation:

1. `pi` starts in Sisyphus mode — footer shows turquoise `sisyphus`, all tools available.
2. `/mode prometheus` → footer shows orange `prometheus`, edit/write tools blocked.
3. Ask "add authentication to this app" → Prometheus interviews, researches, writes plan via `plan_write`.
4. Choose "Execute" → mode switches to Atlas, footer shows green `atlas`, all tools available.
5. Atlas creates tasks from plan, executes steps, shows progress widget.
6. All tasks done → mode returns to Sisyphus, footer shows turquoise `sisyphus`.
7. `/mode prometheus` → back to planning mode.
8. Session resume → mode correctly restored from persisted state.
9. `--mode prometheus` CLI flag → starts in Prometheus mode instead of Sisyphus.
