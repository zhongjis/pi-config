/**
 * builtin-agents.ts — Load runtime-internal agent definitions shipped with this extension.
 * They are never registered, so no roster, `/agents`, `agent` tool call, or graph node can select them.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentMarkdown } from "../../lib/agent-frontmatter.js";
import { toAgentConfig } from "./custom-agents.js";
import type { AgentConfig } from "./types.js";

const GRAPH_CLASSIFIER_AGENT_PATH = fileURLToPath(new URL("../builtin-agents/graph-classifier-agent.md", import.meta.url));
const loaded = new Map<string, AgentConfig>();

/**
 * Load the decision-gate classifier definition. Fails closed unless it is a
 * valid, isolated, tool-free `prompt_mode: replace` definition without model,
 * thinking, or inherited context; the caller supplies the exact model.
 */
export function loadGraphClassifierAgent(path = GRAPH_CLASSIFIER_AGENT_PATH): AgentConfig {
  const cached = loaded.get(path);
  if (cached) return cached;
  const parsed = parseAgentMarkdown(readFileSync(path, "utf-8"));
  const fm = parsed.frontmatter;
  const problems = parsed.diagnostics.map((d) => `${d.field}: ${d.message}`);
  if (Object.hasOwn(fm, "model") || Object.hasOwn(fm, "thinking")) problems.push("model and thinking must come from the caller");
  if (parsed.toolRules.length > 0 || parsed.extensionRules.length > 0 || parsed.isolated !== true) {
    problems.push("must be isolated with no tools or extensions");
  }
  if (fm.prompt_mode !== "replace") problems.push("prompt_mode must be replace");
  if (parsed.inheritContext === true) problems.push("inherit_context must be off");
  if (problems.length > 0) throw new Error(`Invalid built-in agent ${path}: ${problems.join("; ")}`);
  const config = toAgentConfig(basename(path, ".md"), parsed, "default");
  loaded.set(path, config);
  return config;
}
