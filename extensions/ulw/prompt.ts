// ---------------------------------------------------------------------------
// Ultrawork prompt loader — model-adapted variant selection.
//
// Prompt bodies live as sibling Markdown files under ./prompts/ (kept out of
// TypeScript so wording/order stays faithful to upstream and easy to diff):
//   - prompts/default.md — Claude / default variant (adapted from
//     oh-my-openagent ultrawork/default.md)
//   - prompts/gpt.md     — OpenAI / GPT variant (adapted from
//     oh-my-openagent ultrawork/gpt.md)
//
// Selection mirrors the modes extension: Claude is the default; switch to the
// GPT variant only when the active model is a GPT-family (OpenAI) model.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isGptModel } from "../lib/model-family.js";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

const cache = new Map<string, string>();

function loadPrompt(variant: "default" | "gpt"): string {
  const cached = cache.get(variant);
  if (cached !== undefined) return cached;
  const content = readFileSync(join(PROMPTS_DIR, `${variant}.md`), "utf-8").trim();
  cache.set(variant, content);
  return content;
}

/**
 * Resolve the ultrawork prompt for the active model.
 * Claude (and anything non-GPT) → default variant; GPT-family (OpenAI) → gpt variant.
 */
export function getUltraworkPrompt(model?: { provider: string; id: string }): string {
  const variant = model && isGptModel(model) ? "gpt" : "default";
  return loadPrompt(variant);
}
