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
    promptMode: parsed.promptMode,
    builtinToolNames: parsed.toolSelectionSpecified ? parsed.builtinToolNames : undefined,
    extensionToolNames: parsed.toolSelectionSpecified ? parsed.extensionToolNames : undefined,
    extensions: parsed.toolSelectionSpecified ? parsed.extensions : undefined,
    allowDelegationTo: parsed.allowDelegationTo,
    disallowDelegationTo: parsed.disallowDelegationTo,
    allowNesting: parsed.allowNesting,
    model: parsed.model,
  };
}

export function loadAgentConfig(mode: Mode): ModeConfig | null {
  const globalPath = join(homedir(), ".pi", "agent", "agents", `${mode}.md`);

  if (!existsSync(globalPath)) return null;

  try {
    return parseModeAgentConfig(readFileSync(globalPath, "utf-8"));
  } catch {
    return null;
  }
}
