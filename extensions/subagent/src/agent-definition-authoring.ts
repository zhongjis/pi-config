import { BUILTIN_TOOL_NAMES } from "./agent-types.js";
import type { AgentConfig } from "./types.js";

export function formatAgentToolList(names: string[] | undefined, defaults: string[] = BUILTIN_TOOL_NAMES): string {
  const selected = names ?? defaults;
  return selected.length > 0 ? selected.join(", ") : "none";
}

export function buildEjectedAgentMarkdown(cfg: AgentConfig): string {
  const fmFields: string[] = [];
  fmFields.push(`description: ${cfg.description}`);
  if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`);
  fmFields.push(`builtin_tools: ${formatAgentToolList(cfg.builtinToolNames)}`);
  if (cfg.extensionToolNames !== undefined) fmFields.push(`extension_tools: ${formatAgentToolList(cfg.extensionToolNames, [])}`);
  if (cfg.model) fmFields.push(`model: ${cfg.model}`);
  if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
  fmFields.push(`prompt_mode: ${cfg.promptMode}`);
  if (cfg.extensions === false) fmFields.push("extensions: false");
  else if (Array.isArray(cfg.extensions)) fmFields.push(`extensions: ${cfg.extensions.join(", ")}`);
  if (cfg.skills === false) fmFields.push("skills: false");
  else if (Array.isArray(cfg.skills)) fmFields.push(`skills: ${cfg.skills.join(", ")}`);
  if (cfg.inheritContext) fmFields.push("inherit_context: true");
  if (cfg.runInBackground) fmFields.push("run_in_background: true");
  if (cfg.isolated) fmFields.push("isolated: true");
  if (cfg.memory) fmFields.push(`memory: ${cfg.memory}`);
  if (cfg.isolation) fmFields.push(`isolation: ${cfg.isolation}`);

  return `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;
}

export interface ManualAgentMarkdownOptions {
  description: string;
  builtinTools: string;
  extensionsLine?: string;
  extensionToolsLine?: string;
  modelLine?: string;
  thinkingLine?: string;
  allowDelegationLine?: string;
  disallowDelegationLine?: string;
  systemPrompt: string;
}

export function buildManualAgentMarkdown(options: ManualAgentMarkdownOptions): string {
  return `---
description: ${options.description}
builtin_tools: ${options.builtinTools}${options.extensionsLine ?? ""}${options.extensionToolsLine ?? ""}${options.modelLine ?? ""}${options.thinkingLine ?? ""}${options.allowDelegationLine ?? ""}${options.disallowDelegationLine ?? ""}
prompt_mode: replace
---

${options.systemPrompt}
`;
}

export function buildGenerateAgentPrompt(description: string, targetPath: string): string {
  return `Create a custom pi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
builtin_tools: <comma-separated built-in tools: ${BUILTIN_TOOL_NAMES.join(", ")}. Prefer read, bash, edit, write for new agents; use bash with rg/fd for search/listing instead of grep/find/ls tools. Use "none" for no built-in tools. Omit for default built-in tools: ${BUILTIN_TOOL_NAMES.join(", ")}>
extensions: <true (extension/MCP tools available), false (none), or comma-separated extension/MCP source names preserved where supported. Current active-tool filtering treats CSV as enabled, not exact tool selection. Default: true>
extension_tools: <optional exact comma-separated extension/MCP tool names to allow after extensions are available. Use "none" for no extension tools. Omit to allow all available extension tools>
model: <optional model as "provider/modelId", e.g. "anthropic/claude-haiku-4-5-20251001". Omit to inherit parent model>
thinking: <optional thinking level: none, minimal, low, medium, high, xhigh. Omit to inherit>
max_turns: <optional max agentic turns. 0 or omit for unlimited (default)>
prompt_mode: <"replace" (body IS the full system prompt) or "append" (body is appended to default prompt). Default: replace>
skills: <true (inherit all), false (none), or comma-separated skill names to preload into prompt. Default: true>
allow_delegation_to: <comma-separated agent names this agent may delegate to via Agent. Omit for unrestricted delegation>
disallow_delegation_to: <comma-separated agent names this agent may not delegate to via Agent. Omit for none>
inherit_context: <true to fork parent conversation into agent so it sees chat history. Default: false>
run_in_background: <true to run in background by default. Default: false>
isolated: <true for no extension/MCP tools, only built-in tools. Default: false>
memory: <"user" (global), "project" (per-project), or "local" (gitignored per-project) for persistent memory. Omit for none>
isolation: <"worktree" to run in isolated git worktree. Omit for normal>
---

<system prompt body — instructions for the agent>
\`\`\`

Tool field rules:
- Old \`tools:\` frontmatter is invalid/obsolete; use \`builtin_tools:\` for built-in tools and \`extension_tools:\` for extension/custom tools.
- Old tool denylist fields \`disallowed_tools:\` and \`disallow_tools:\` are invalid and obsolete; do not write them.
- Put extension/MCP availability or source-scope hints in \`extensions:\`; CSV is not a fuzzy tool matcher and current active-tool filtering treats CSV as enabled.
- Put exact extension/MCP tool-name filters in \`extension_tools:\`; omit it to allow all available extension tools, or set \`extension_tools: none\` for no extension tools.

Guidelines for choosing settings:
- For read-only tasks (review, analysis): builtin_tools: read, bash; use bash commands rg/fd for search/listing
- For code modification tasks: include edit, write in builtin_tools
- Use prompt_mode: append if the agent should keep the default system prompt and add specialization on top
- Use prompt_mode: replace for fully custom agents with their own personality/instructions
- Set inherit_context: true if the agent needs to know what was discussed in the parent conversation
- Set isolated: true if the agent should NOT have access to MCP servers or other extensions
- Use allow_delegation_to and disallow_delegation_to to restrict which other agents this agent may spawn via Agent; the allowlist is applied first, then disallow_delegation_to removes from that set
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Write the file using the write tool. Only write the file, nothing else.`;
}
