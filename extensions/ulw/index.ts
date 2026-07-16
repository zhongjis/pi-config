/**
 * ulw — Ultrawork mode extension for pi.
 *
 * Adapted from oh-my-openagent's ultrawork / keyword-detector feature.
 * Source: https://github.com/code-yeongyu/oh-my-openagent
 *
 * Behaviour:
 *   - User message contains "ultrawork" or "ulw" anywhere (case-insensitive)
 *   - Extension preserves the keyword in user text and injects the ultrawork
 *     prompt as a separate context message via before_agent_start (collapsed,
 *     not visible in user message — similar to how skills inject context)
 *   - Notification shown on activation
 *
 * Pi-native adaptation:
 *   - omo agent calls (task/subagent_type) → pi Agent tool names (chengfeng/wenchang/taishang/xuannv/jintong)
 *   - Model-adapted prompt: Claude/default variant by default, OpenAI/GPT
 *     variant when the active model is GPT-family (see prompt.ts)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getUltraworkPrompt } from "./prompt.js";
// @ts-expect-error repo test/runtime alias resolves @earendil-works/pi-tui; LSP may miss it.
import { Box, Text } from "@earendil-works/pi-tui";

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
//   1. input handler: detect keyword, preserve the input, set pending flag
//   2. before_agent_start handler: inject ultrawork prompt as collapsed message
// This keeps the ultrawork prompt separate from the user message.
// Ultrawork only activates in kuafu mode — other modes have their own flow.

export default function ulwExtension(pi: ExtensionAPI): void {
  // Flag: ultrawork was triggered for the current input, pending injection
  let pendingUltrawork = false;

  // Compact activation banner rendered in the transcript when ultrawork fires.
  // The injected prompt message (display: true) renders through this instead of
  // dumping the full directive; ctrl+o expands it. Replaces the old footer status
  // badge + global notification (both removed).
  pi.registerMessageRenderer("ultrawork", (message, { expanded }, theme) => {
    const label = theme.fg("customMessageLabel", "\x1b[1m⚡ [ultrawork]\x1b[22m");
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(
      new Text(
        `${label} ${theme.fg("customMessageText", "mode activated")}${theme.fg("dim", " (ctrl+o to expand)")}`,
        0,
        0,
      ),
    );
    if (expanded) {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string" && content.length > 0) {
        box.addChild(new Text(theme.fg("dim", content), 0, 0));
      }
    }
    return box;
  });

  pi.on("input", async (event, ctx) => {
    const raw = event.text ?? "";
    if (!hasUlwKeyword(raw)) {
      return { action: "continue" };
    }

    // Only trigger in kuafu (default build) mode. In other modes, leave the
    // input untouched so mode-specific flows can handle it normally.
    const mode = getCurrentMode(ctx);
    if (mode !== "kuafu") {
      return { action: "continue" };
    }

    const keywordOnly = /^(ultrawork|ulw)$/i.test(raw.trim());

    // Set flag for before_agent_start to inject the prompt
    pendingUltrawork = true;

    if (keywordOnly) {
      // Keyword only, no task
      return {
        action: "transform",
        text: "Ultrawork mode is now active. What task should I work on?",
      };
    }

    return { action: "transform", text: raw };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!pendingUltrawork) return;
    pendingUltrawork = false;
    if (getCurrentMode(ctx) !== "kuafu") return;

    return {
      message: {
        customType: "ultrawork",
        content: getUltraworkPrompt(ctx.model),
        display: true,
      },
    };
  });
}
