/**
 * ulw — Ultrawork mode extension for pi.
 *
 * Adapted from oh-my-openagent's ultrawork / keyword-detector feature.
 * Source: https://github.com/code-yeongyu/oh-my-openagent
 *
 * Behaviour:
 *   - User starts a message with "ultrawork" or "ulw" (case-insensitive)
 *   - Extension strips the keyword and prepends the ultrawork prompt to
 *     the user message text (message-level injection, like OmO)
 *   - Notification shown on activation
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

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;

/** Keyword anchored to start of input — this is a command prefix, not global search. */
const ULW_PREFIX_RE = /^\s*(ultrawork|ulw)\b\s*/i;

function hasUlwKeyword(text: string): boolean {
  // Strip code blocks before detection to avoid false positives
  // when discussing the extension itself or pasting code containing the keyword.
  const clean = text.replace(CODE_BLOCK_RE, "").replace(INLINE_CODE_RE, "");
  return ULW_PREFIX_RE.test(clean);
}

function stripUlwKeyword(text: string): string {
  return text.replace(ULW_PREFIX_RE, "").trim();
}

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

/** Read current mode from session entries (persisted by modes extension). */
function getCurrentMode(ctx: ExtensionContext): string {
  try {
    const entries = ctx.sessionManager.getEntries();
    const modeEntry = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "agent-mode")
      .pop() as { data?: { mode?: string } } | undefined;
    return modeEntry?.data?.mode ?? "kuafu";
  } catch {
    // Defensive: if sessionManager or getEntries() unavailable, default to kuafu
    return "kuafu";
  }
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------
// NOTE: This handler participates in pi's input transform chain.
// Other extensions (modes, smart-sessions) also register input handlers.
// Transforms chain in registration order; "handled" would short-circuit.
// This handler returns "continue" for non-matching input and "transform"
// for keyword matches, allowing downstream handlers to further process.
// Ultrawork only activates in kuafu mode — other modes have their own flow.

export default function ulwExtension(pi: ExtensionAPI): void {
  pi.on("input", async (event, ctx) => {
    const raw = event.text ?? "";
    if (!hasUlwKeyword(raw)) {
      return { action: "continue" };
    }

    // Only activate in kuafu (default build) mode
    const mode = getCurrentMode(ctx);
    if (mode !== "kuafu") {
      if (ctx.hasUI) {
        ctx.ui.notify(`⚡ Ultrawork skipped — active mode is ${mode}`, "warning");
      }
      // Strip keyword but don't inject prompt
      const stripped = stripUlwKeyword(raw);
      return stripped ? { action: "transform", text: stripped } : { action: "continue" };
    }

    const stripped = stripUlwKeyword(raw);

    if (ctx.hasUI) {
      ctx.ui.notify("⚡ Ultrawork Mode Activated", "success");
    }

    if (!stripped) {
      // Keyword only, no task — inject prompt as the message
      return {
        action: "transform",
        text: `${ULTRAWORK_PROMPT}\n\n---\n\nUltrawork mode is now active. What task should I work on?`,
      };
    }

    // Prepend ultrawork prompt to user message (message-level injection)
    return {
      action: "transform",
      text: `${ULTRAWORK_PROMPT}\n\n---\n\n${stripped}`,
    };
  });
}
