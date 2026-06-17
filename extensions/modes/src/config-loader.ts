import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseAgentMarkdown,
} from "../../lib/agent-frontmatter.js";
import type { Mode, ModeConfig } from "./types.js";

export function parseModeAgentConfig(content: string): ModeConfig | null {
  const parsed = parseAgentMarkdown(content);
  const trimmedBody = parsed.body.trim();
  if (!trimmedBody || parsed.invalidFields.length > 0) return null;

  return {
    body: trimmedBody,
    // modes treat any non-append (incl. system_instructions) as replace; AGENTS.md inheritance is irrelevant here
    promptMode: parsed.promptMode === "append" ? "append" : "replace",
    builtinToolNames: parsed.toolSelectionSpecified ? parsed.builtinToolNames : undefined,
    extensionToolNames: parsed.toolSelectionSpecified ? parsed.extensionToolNames : undefined,
    extensions: parsed.toolSelectionSpecified ? parsed.extensions : undefined,
    allowDelegationTo: parsed.allowDelegationTo,
    disallowDelegationTo: parsed.disallowDelegationTo,
    allowNesting: parsed.allowNesting,
    model: parsed.model,
  };
}

export function loadAgentConfig(mode: Mode, family?: "gpt" | "gemini" | "default"): ModeConfig | null {
  const modeDir = join(homedir(), ".pi", "agent", "modes", mode);
  const modePath = join(modeDir, "mode.md");

  if (!existsSync(modePath)) return null;

  let baseConfig: ModeConfig | null;
  try {
    baseConfig = parseModeAgentConfig(readFileSync(modePath, "utf-8"));
  } catch {
    return null;
  }
  if (!baseConfig) return null;

  // GPT family: gpt.md replaces the prompt body (body-only file, no frontmatter)
  if (family === "gpt") {
    const gptPath = join(modeDir, "gpt.md");
    if (existsSync(gptPath)) {
      try {
        const gptBody = readFileSync(gptPath, "utf-8").trim();
        if (gptBody) return { ...baseConfig, body: gptBody };
      } catch {
        /* fall through to base config */
      }
    }
    return baseConfig;
  }

  // Gemini family: gemini.md is an overlay fragment (body-only file, no frontmatter)
  if (family === "gemini") {
    const geminiPath = join(modeDir, "gemini.md");
    if (existsSync(geminiPath)) {
      try {
        const overlays = readFileSync(geminiPath, "utf-8").trim();
        if (overlays) return { ...baseConfig, overlays };
      } catch {
        /* fall through to base config */
      }
    }
    return baseConfig;
  }

  // default or undefined: use mode.md body unchanged
  return baseConfig;
}
