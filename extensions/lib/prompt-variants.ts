import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { getModePromptSource } from "./model-family.js";

export type PromptFamily = ReturnType<typeof getModePromptSource>;

/** Optional variant bodies are trimmed and non-empty. */
export interface PromptVariants {
  readonly gpt?: string;
  readonly gemini?: string;
}

function readPromptFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    return undefined;
  }
}

export function readPromptVariantDir(dir: string): {
  defaultPath: string;
  defaultContent: string;
  variants: PromptVariants;
} | undefined {
  const defaultPath = join(dir, "default.md");
  const defaultContent = readPromptFile(defaultPath);
  if (defaultContent === undefined) return undefined;
  const gpt = readPromptFile(join(dir, "gpt.md"))?.trim();
  const gemini = readPromptFile(join(dir, "gemini.md"))?.trim();
  return {
    defaultPath,
    defaultContent,
    variants: { ...(gpt ? { gpt } : {}), ...(gemini ? { gemini } : {}) },
  };
}

export function selectPromptBody(body: string, variants: PromptVariants, family: PromptFamily): string {
  if (family === "gpt" && variants.gpt) return variants.gpt;
  if (family === "gemini" && variants.gemini) return injectOverlays(body, variants.gemini);
  return body;
}

export function injectOverlays(body: string, overlays: string): string {
  // Inject overlays BEFORE <critical> section (lost-in-the-middle fix)
  const anchor = "<critical>";
  const idx = body.indexOf(anchor);
  if (idx !== -1) {
    return `${body.slice(0, idx)}${overlays}\n\n${body.slice(idx)}`;
  }
  // Fallback: inject AFTER </role> if no <critical> found
  const roleClose = "</role>";
  const roleIdx = body.indexOf(roleClose);
  if (roleIdx !== -1) {
    const insertAt = roleIdx + roleClose.length;
    return `${body.slice(0, insertAt)}\n\n${overlays}${body.slice(insertAt)}`;
  }
  // Last resort: append at end
  return `${body}\n\n${overlays}`;
}

