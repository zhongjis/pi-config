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
import { ULTRAWORK_PROMPT } from "./prompt.js";


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
