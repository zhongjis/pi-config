/**
 * ulw — Ultrawork mode extension for pi.
 *
 * Adapted from oh-my-openagent's ultrawork / keyword-detector feature.
 * Source: https://github.com/code-yeongyu/oh-my-openagent
 *
 * Behaviour:
 *   - User starts a message with "ultrawork" or "ulw" (case-insensitive)
 *   - Extension strips the keyword, sets a one-shot per-session flag
 *   - On before_agent_start the ultrawork system prompt is prepended (once)
 *   - /ulw [on|sticky|off|status] command for manual control
 *   - Status bar shows "⚡ ULW" while a flagged turn is pending
 *
 * Pi-native adaptation:
 *   - omo agent calls (task/subagent_type) → pi Agent tool names (chengfeng/wenchang/taishang/fuxi/jintong)
 *   - Model routing removed (pi manages model selection)
 *   - Loop mechanism removed (pi handles conversation continuation)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Ultrawork system prompt
// Adapted from oh-my-openagent src/hooks/keyword-detector/ultrawork/default.ts
// ---------------------------------------------------------------------------

const ULTRAWORK_PROMPT = `<ultrawork-mode>

**MANDATORY**: Say "ULTRAWORK MODE ENABLED!" as your first output when this activates.

[CODE RED] Maximum precision required. Think deeply before acting.

## ABSOLUTE CERTAINTY REQUIRED

**DO NOT START IMPLEMENTATION UNTIL 100% CERTAIN.**

| BEFORE ANY CODE, YOU MUST: |
|----------------------------|
| FULLY UNDERSTAND what the user actually wants (not what you assume) |
| EXPLORE the codebase to understand existing patterns, architecture, context |
| HAVE A CRYSTAL CLEAR WORK PLAN — vague plan = failed work |
| RESOLVE ALL AMBIGUITY — if anything is unclear, investigate or ask |

### MANDATORY CERTAINTY PROTOCOL

**IF NOT 100% CERTAIN:**

1. **THINK DEEPLY** — What is the user's TRUE intent? What problem are they REALLY solving?
2. **EXPLORE THOROUGHLY** — Use chengfeng (codebase recon) and wenchang (external research) subagents in parallel
3. **CONSULT SPECIALISTS** — For hard/complex tasks, do NOT struggle alone. Delegate:
   - **taishang**: Architecture, debugging, complex logic, security
   - **fuxi**: Planning, decomposition, multi-stream work
4. **ASK THE USER** — If ambiguity remains after exploration, ASK. Don't guess.

**SIGNS YOU ARE NOT READY:**
- Making assumptions about requirements
- Unsure which files to modify
- Don't understand how existing code works
- Plan contains "probably" or "maybe"
- Can't explain the exact steps

**WHEN IN DOUBT — delegate first:**
\`\`\`
// Codebase recon (background, parallel)
Agent(chengfeng, run_in_background=true):
  "Implementing [TASK]. Find [X] patterns — file paths, approach, conventions used.
   Focus on src/. Skip test files unless test patterns needed.
   Return concrete paths with brief descriptions."

// External research (background, parallel)
Agent(wenchang, run_in_background=true):
  "Need [LIBRARY/TECH] info: API reference, config options, recommended patterns, pitfalls.
   Skip tutorials. I'll use this to [DECISION THIS INFORMS]."

// Architecture review (foreground, blocking)
Agent(taishang):
  "Review approach to [TASK]. Plan: [DESCRIBE PLAN WITH FILES + CHANGES].
   Concerns: [LIST UNCERTAINTIES]. Evaluate: correctness, issues I'm missing, better alternatives."
\`\`\`

**ONLY AFTER:**
- Gathered context via agents
- Resolved all ambiguities
- Created precise step-by-step plan
- Achieved 100% confidence in understanding

**...THEN AND ONLY THEN begin implementation.**

---

## NO EXCUSES. DELIVER WHAT WAS ASKED.

**THE USER'S REQUEST IS SACRED. FULFILL IT EXACTLY.**

| VIOLATION | CONSEQUENCE |
|-----------|-------------|
| "I couldn't because..." | UNACCEPTABLE. Find a way or ask. |
| "This is a simplified version..." | UNACCEPTABLE. Full implementation only. |
| "You can extend this later..." | UNACCEPTABLE. Finish it NOW. |
| "Due to limitations..." | UNACCEPTABLE. Use agents and tools. |
| "I made some assumptions..." | UNACCEPTABLE. Should have asked first. |

**IF YOU ENCOUNTER A BLOCKER:**
1. DO NOT give up
2. DO NOT deliver compromised version
3. DO consult taishang (architecture/logic) or fuxi (planning)
4. DO ask user for guidance
5. DO explore alternative approaches

**THE USER ASKED FOR X. DELIVER EXACTLY X. PERIOD.**

---

## ORCHESTRATION PRINCIPLES

**DEFAULT: DELEGATE. DO NOT WORK ALONE.**

| Task Type | Agent | Mode |
|-----------|-------|------|
| Codebase discovery, pattern finding | chengfeng | background |
| External docs, web research | wenchang | background |
| Planning, decomposition | fuxi | foreground |
| Architecture, hard problems, review | taishang | foreground |
| UI, visual, frontend | nuwa | background |
| Bounded implementation, isolated work | jintong | background |

**DO IT YOURSELF ONLY WHEN:**
- Task is trivially simple (1–2 lines, obvious change)
- You have ALL context already loaded
- Delegation overhead exceeds task complexity

**OTHERWISE: DELEGATE. ALWAYS.**

---

## EXECUTION RULES

- **TODO**: Track EVERY step. Mark complete immediately after each.
- **PARALLEL**: Fire independent agent calls in background simultaneously — never wait sequentially.
- **VERIFY**: Re-read request after completion. ALL requirements met before reporting done.
- **NO SCOPE REDUCTION**: Never deliver "demo", "skeleton", "simplified", or "basic" versions.
- **NO PARTIAL COMPLETION**: Never stop at 60–80% — finish 100%.
- **NO TEST DELETION**: Never delete or skip failing tests to make the build pass. Fix the code.

## WORKFLOW

1. Analyze request — identify required capabilities and knowledge gaps
2. Spawn chengfeng + wenchang in parallel background for exploration
3. Consult fuxi or taishang with gathered context for planning
4. Execute via jintong / nuwa for bounded implementation work
5. Verify against original requirements with evidence

## VERIFICATION GUARANTEE (NON-NEGOTIABLE)

**NOTHING is "done" without PROOF it works.**

### Pre-Implementation: Define Success Criteria

BEFORE any code:

| Type | Description | Example |
|------|-------------|---------|
| Functional | Specific behavior that must work | "Button click triggers API call" |
| Observable | What can be measured / seen | "Console shows 'success', no errors" |
| Pass/Fail | Binary — no ambiguity | "Returns 200 OK" |

### Manual QA Mandate

YOU MUST execute manual QA yourself. lsp_diagnostics catches type errors, NOT functional bugs.

| If your change... | YOU MUST... |
|---|---|
| Adds/modifies a CLI command | Run it. Show output. |
| Changes build output | Run build. Verify output files exist and are correct. |
| Modifies API behavior | Call the endpoint. Show response. |
| Changes UI rendering | Test it. Describe what you see. |
| Adds a new feature | Test end-to-end in real scenario. |

**Unacceptable claims:**
- "This should work" — RUN IT.
- "Types check out" — Types ≠ functional correctness. RUN IT.
- "lsp_diagnostics clean" — Type check only. RUN IT.

---

THE USER ASKED FOR X. DELIVER EXACTLY X. NOT A SUBSET. NOT A DEMO. NOT A STARTING POINT.

1. EXPLORE (chengfeng + wenchang in parallel background)
2. PLAN (fuxi or taishang with full context)
3. EXECUTE (delegate to jintong / nuwa, verify with evidence)

NOW.

</ultrawork-mode>`;

// ---------------------------------------------------------------------------
// Keyword detection
// ---------------------------------------------------------------------------

const ULW_PATTERN = /\b(ultrawork|ulw)\b\s*/gi;

function hasUlwKeyword(text: string): boolean {
  ULW_PATTERN.lastIndex = 0;
  return ULW_PATTERN.test(text);
}

function stripUlwKeyword(text: string): string {
  ULW_PATTERN.lastIndex = 0;
  return text.replace(ULW_PATTERN, "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

/** Sessions with a one-shot pending ultrawork injection (next agent start only). */
const pendingUlw = new Set<string>();

/** Sessions with sticky ultrawork (every agent start gets injected). */
const stickyUlw = new Set<string>();

function getSessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId() ?? "__global__";
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function ulwExtension(pi: ExtensionAPI): void {
  // ------------------------------------------------------------------
  // input event — detect keyword, strip it, arm one-shot flag
  // ------------------------------------------------------------------
  pi.on("input", async (event, ctx) => {
    const raw = event.text ?? "";
    if (!hasUlwKeyword(raw)) {
      return { action: "continue" };
    }

    const key = getSessionKey(ctx);
    pendingUlw.add(key);

    const stripped = stripUlwKeyword(raw);

    if (ctx.hasUI) {
      ctx.ui.notify("⚡ ULTRAWORK MODE — directive armed for this turn.", "info");
      ctx.ui.setStatus("ulw", "⚡ ULW");
    }

    if (!stripped) {
      // Keyword only, no task — tell user it's armed
      return {
        action: "transform",
        text: "Ultrawork mode is now armed. What task should I work on?",
      };
    }

    return { action: "transform", text: stripped };
  });

  // ------------------------------------------------------------------
  // before_agent_start — inject ultrawork prompt (one-shot or sticky)
  // ------------------------------------------------------------------
  pi.on("before_agent_start", async (event, ctx) => {
    const key = getSessionKey(ctx);
    const isPending = pendingUlw.has(key);
    const isSticky = stickyUlw.has(key);

    if (!isPending && !isSticky) {
      return;
    }

    // Consume one-shot flag
    if (isPending) {
      pendingUlw.delete(key);
    }

    // Update status bar
    if (ctx.hasUI) {
      if (isSticky) {
        ctx.ui.setStatus("ulw", "⚡ ULW (sticky)");
      } else {
        // One-shot consumed — clear status
        ctx.ui.setStatus("ulw", undefined);
      }
    }

    const base = event.systemPrompt ?? "";
    return {
      systemPrompt: base ? `${base}\n\n${ULTRAWORK_PROMPT}` : ULTRAWORK_PROMPT,
    };
  });

  // ------------------------------------------------------------------
  // /ulw command — manual control
  // ------------------------------------------------------------------
  pi.registerCommand("ulw", {
    description: "Ultrawork mode: /ulw [on|sticky|off|status]",
    getArgumentCompletions: (prefix: string) => {
      const opts = [
        { value: "status", label: "status — show current ulw state" },
        { value: "on", label: "on — arm ultrawork for the next agent turn" },
        { value: "sticky", label: "sticky — enable ultrawork for every turn in this session" },
        { value: "off", label: "off — clear all ultrawork flags for this session" },
      ];
      const normalized = prefix.trim().toLowerCase();
      const filtered = opts.filter((o) => o.value.startsWith(normalized));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      const key = getSessionKey(ctx);

      if (!arg || arg === "status") {
        const isSticky = stickyUlw.has(key);
        const isPending = pendingUlw.has(key);
        const state = isSticky
          ? "sticky (every turn)"
          : isPending
          ? "armed (next turn only)"
          : "off";
        ctx.ui.notify(
          `⚡ Ultrawork: ${state}\n/ulw on | sticky | off to change`,
          "info",
        );
        return;
      }

      if (arg === "on") {
        pendingUlw.add(key);
        ctx.ui.setStatus("ulw", "⚡ ULW");
        ctx.ui.notify("⚡ Ultrawork armed for next turn.", "info");
        return;
      }

      if (arg === "sticky") {
        stickyUlw.add(key);
        ctx.ui.setStatus("ulw", "⚡ ULW (sticky)");
        ctx.ui.notify(
          "⚡ Ultrawork sticky mode enabled — every turn this session.",
          "info",
        );
        return;
      }

      if (arg === "off") {
        pendingUlw.delete(key);
        stickyUlw.delete(key);
        ctx.ui.setStatus("ulw", undefined);
        ctx.ui.notify("Ultrawork disabled.", "info");
        return;
      }

      ctx.ui.notify(
        `Unknown argument: ${arg}\nUsage: /ulw [on|sticky|off|status]`,
        "error",
      );
    },
  });
}
