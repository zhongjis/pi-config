import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseAgentMarkdown,
} from "../../lib/agent-frontmatter.js";
import { type PromptFamily, readPromptVariantDir, selectPromptBody } from "../../lib/prompt-variants.js";
import type { Mode, ModeConfig } from "./types.js";

export function parseModeAgentConfig(content: string): ModeConfig | null {
  const parsed = parseAgentMarkdown(content, { kind: "mode" });
  // An invalid mode file fails closed: no prompt, no tools, its errors reported.
  if (parsed.invalidFields.length > 0) {
    return { body: "", toolRules: [], errors: parsed.diagnostics.filter((d) => d.severity === "error").map((d) => d.message) };
  }
  const trimmedBody = parsed.body.trim();
  if (!trimmedBody) return null;

  return {
    body: trimmedBody,
    toolRules: parsed.toolRules,
    delegationRules: parsed.delegationRules,
    model: parsed.model,
  };
}

export function loadAgentConfig(mode: Mode, family?: PromptFamily): ModeConfig | null {
  const modeDir = join(homedir(), ".pi", "agent", "modes", mode);
  const source = readPromptVariantDir(modeDir);
  if (!source) return null;

  const baseConfig = parseModeAgentConfig(source.defaultContent);
  if (!baseConfig || baseConfig.errors) return baseConfig;
  return { ...baseConfig, body: selectPromptBody(baseConfig.body, source.variants, family ?? "default") };
}
