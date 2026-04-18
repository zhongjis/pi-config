/**
 * ulw — Ultrawork mode extension for pi.
 *
 * Adapted from oh-my-openagent's ultrawork / keyword-detector feature.
 * Source: https://github.com/code-yeongyu/oh-my-openagent
 *
 * Behaviour:
 *   - User message contains "ultrawork" or "ulw" anywhere (case-insensitive)
 *   - Extension strips the keyword from user text and injects the ultrawork
 *     prompt as a separate context message via before_agent_start (collapsed,
 *     not visible in user message — similar to how skills inject context)
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

/**
 * Matches the ultrawork prompt block itself — prevents the prompt content
 * (which contains "ultrawork") from re-triggering keyword detection.
 */
const ULTRAWORK_BLOCK_RE = /<ultrawork-mode>[\s\S]*?<\/ultrawork-mode>/gi;

/**
 * Matches @-prefixed references that should NOT trigger detection.
 * Covers: @ulw, @extensions/ulw, @extensions/ulw/, @extensions/ulw/index.ts, etc.
 * Pi passes @file references as raw text in event.text.
 */
const AT_REF_RE = /@(?:extensions\/)?ulw\b[^\s]*/gi;

/** Keyword anywhere in text (word-boundary, case-insensitive). */
const ULW_KEYWORD_RE = /\b(ultrawork|ulw)\b/i;

/**
 * Sanitize text before keyword detection: strip ultrawork prompt blocks,
 * code blocks, inline code, and @-prefixed file references to avoid
 * false positives.
 */
function sanitize(text: string): string {
  return text
    .replace(ULTRAWORK_BLOCK_RE, "")
    .replace(CODE_BLOCK_RE, "")
    .replace(INLINE_CODE_RE, "")
    .replace(AT_REF_RE, "");
}

function hasUlwKeyword(text: string): boolean {
  return ULW_KEYWORD_RE.test(sanitize(text));
}

/** Strip only the first occurrence of the keyword from the raw text. */
function stripUlwKeyword(text: string): string {
  return text.replace(ULW_KEYWORD_RE, "").replace(/  +/g, " ").trim();
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
// Two-phase approach:
//   1. input handler: detect keyword, strip it, set pending flag
//   2. before_agent_start handler: inject ultrawork prompt as collapsed message
// This keeps the ultrawork prompt out of the user message (cleaner context).
// Ultrawork only activates in kuafu mode — other modes have their own flow.

export default function ulwExtension(pi: ExtensionAPI): void {
  // Flag: ultrawork was triggered for the current input, pending injection
  let pendingUltrawork = false;

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
        ctx.ui.setStatus("ultrawork", undefined);
      }
      // Strip keyword but don't inject prompt
      const stripped = stripUlwKeyword(raw);
      return stripped ? { action: "transform", text: stripped } : { action: "continue" };
    }

    const stripped = stripUlwKeyword(raw);

    if (ctx.hasUI) {
      ctx.ui.notify("⚡ Ultrawork Mode Activated", "success");
      ctx.ui.setStatus("ultrawork", "⚡ Ultrawork");
    }

    // Set flag for before_agent_start to inject the prompt
    pendingUltrawork = true;

    if (!stripped) {
      // Keyword only, no task
      return {
        action: "transform",
        text: "Ultrawork mode is now active. What task should I work on?",
      };
    }

    return { action: "transform", text: stripped };
  });

  pi.on("before_agent_start", async (event) => {
    if (!pendingUltrawork) return;
    pendingUltrawork = false;

    return {
      message: {
        customType: "ultrawork",
        content: ULTRAWORK_PROMPT,
        display: false,
      },
    };
  });
}
