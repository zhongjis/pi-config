import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BUILTIN_TOOL_NAMES } from "./active-tools.js";

export type InheritSelection = true | string[] | false;
export type PromptMode = "replace" | "append" | "system_instructions";

export interface ParsedAgentFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
  invalidFields: string[];
  displayName?: string;
  description?: string;
  builtinToolNames: string[];
  extensionToolNames?: string[];
  allowDelegationTo?: string[];
  disallowDelegationTo?: string[];
  allowNesting?: boolean;
  extensions: InheritSelection;
  excludeExtensions?: string[];
  discoverSkills: boolean;
  preloadSkills: string[];
  model?: string;
  maxTurns?: number;
  promptMode: PromptMode;
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolated?: boolean;
  enabled: boolean;
  toolSelectionSpecified: boolean;
}

/** Parse markdown frontmatter using the shared agent schema. */
export function parseAgentMarkdown(content: string): ParsedAgentFrontmatter {
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
  return parseAgentFrontmatter(frontmatter, body);
}

/** Parse already-extracted frontmatter using the shared agent schema. */
export function parseAgentFrontmatter(
  fm: Record<string, unknown>,
  body = "",
): ParsedAgentFrontmatter {
  return {
    frontmatter: fm,
    body,
    invalidFields: invalidFrontmatterFields(fm),
    displayName: str(fm.display_name),
    description: str(fm.description),
    builtinToolNames: parseBuiltinTools(fm),
    extensionToolNames: csvListOptionalWithNone(fm.extension_tools),
    allowDelegationTo: csvListOptional(fm.allow_delegation_to),
    disallowDelegationTo: csvListOptional(fm.disallow_delegation_to),
    allowNesting: fm.allow_nesting === true,
    extensions: inheritField(fm.extensions ?? fm.inherit_extensions),
    excludeExtensions: csvListOptional(fm.exclude_extensions),
    discoverSkills: parseDiscoverSkills(fm.discover_skills),
    preloadSkills: csvListOptional(fm.preload_skills) ?? [],
    model: str(fm.model),
    maxTurns: nonNegativeInt(fm.max_turns),
    promptMode: parsePromptMode(fm.prompt_mode),
    inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
    runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
    isolated: fm.isolated != null ? fm.isolated === true : undefined,
    enabled: fm.enabled !== false,
    toolSelectionSpecified:
      hasField(fm, "builtin_tools")
      || hasField(fm, "extension_tools")
      || hasField(fm, "extensions")
      || hasField(fm, "inherit_extensions")
      || hasField(fm, "exclude_extensions"),
  };
}

/** Obsolete frontmatter fields make the definition invalid. */
export function invalidFrontmatterFields(fm: Record<string, unknown>): string[] {
  return ["tools", "disallowed_tools", "disallow_tools", "skills", "inherit_skills"].filter((field) => hasField(fm, field));
}

export function invalidFrontmatterFieldMessage(field: string): string {
  if (field === "tools") {
    return "tools is invalid/obsolete; use builtin_tools for built-in tools and extension_tools for extension/custom tools instead.";
  }

  if (field === "skills" || field === "inherit_skills") {
    return "skills/inherit_skills is invalid/obsolete; use discover_skills (catalog on/off) and preload_skills (eager-inject names) instead.";
  }

  return `${field} is invalid/obsolete; use builtin_tools and extension_tools explicit allowlists instead.`;
}

function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

function nonNegativeInt(val: unknown): number | undefined {
  return typeof val === "number" && val >= 0 ? val : undefined;
}

function hasField(fm: Record<string, unknown>, field: string): boolean {
  return Object.hasOwn(fm, field);
}

function onlyBuiltinTools(names: string[]): string[] {
  const builtins = new Set<string>(DEFAULT_BUILTIN_TOOL_NAMES);
  return names.filter((name) => builtins.has(name));
}

function parseBuiltinTools(fm: Record<string, unknown>): string[] {
  if (hasField(fm, "builtin_tools")) {
    return onlyBuiltinTools(csvList(fm.builtin_tools, [...DEFAULT_BUILTIN_TOOL_NAMES]));
  }

  return [...DEFAULT_BUILTIN_TOOL_NAMES];
}

function parseCsvField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const s = String(val).trim();
  if (!s || s === "none") return undefined;
  const items = s.split(",").map((t) => t.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function csvList(val: unknown, defaults: string[]): string[] {
  if (val === undefined || val === null) return defaults;
  return parseCsvField(val) ?? [];
}

function csvListOptional(val: unknown): string[] | undefined {
  return parseCsvField(val);
}

function csvListOptionalWithNone(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  return parseCsvField(val) ?? [];
}


function inheritField(val: unknown): InheritSelection {
  if (val === undefined || val === null || val === true) return true;
  if (val === false || val === "none") return false;
  const items = csvList(val, []);
  return items.length > 0 ? items : false;
}

/** Skill catalog is discoverable unless explicitly disabled. Default true. */
function parseDiscoverSkills(val: unknown): boolean {
  return !(val === false || val === "none" || val === "false");
}

function parsePromptMode(val: unknown): PromptMode {
  if (val === "append") return "append";
  if (val === "system_instructions") return "system_instructions";
  return "replace";
}
