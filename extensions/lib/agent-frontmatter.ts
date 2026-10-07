import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type AccessRule, parseAccessRules } from "./active-tools.js";

export type PromptMode = "replace" | "append" | "system_instructions";

export interface FrontmatterDiagnostic {
  field: string;
  severity: "error" | "warning";
  message: string;
}

export interface ParseAgentOptions {
  /** Mode Agents reject `extensions:`; the main session cannot unload extensions. Default `subagent`. */
  kind?: "subagent" | "mode";
}

export interface ParsedAgentFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
  /** Unique fields with an error diagnostic; non-empty means the definition is invalid. */
  invalidFields: string[];
  displayName?: string;
  description?: string;
  allowDelegationTo?: string[];
  disallowDelegationTo?: string[];
  allowNesting?: boolean;
  discoverSkills: boolean;
  preloadSkills: string[];
  model?: string;
  maxTurns?: number;
  promptMode: PromptMode;
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolated?: boolean;
  enabled: boolean;
  /** Parsed `tools:` signed rules; see `extensions/lib/active-tools.ts`. */
  toolRules: AccessRule[];
  /** Parsed `extensions:` signed rules (Subagents only); see `extensions/lib/active-tools.ts`. */
  extensionRules: AccessRule[];
  /** Field-tagged diagnostics. Errors invalidate the definition; warnings do not. */
  diagnostics: FrontmatterDiagnostic[];
}

const SKILLS_FIELD_MESSAGE = "skills/inherit_skills is invalid/obsolete; use discover_skills (catalog on/off) and preload_skills (eager-inject names) instead.";
const DISALLOWED_TOOLS_HINT = "subtract tools with -name rules in tools:, e.g. `tools: +@all, -edit`.";

/** Obsolete or invalid fields and their rewrite hints. */
const OBSOLETE_FIELD_MESSAGES: Readonly<Record<string, string>> = {
  builtin_tools: "builtin_tools is obsolete; list built-in tools in tools:, e.g. `tools: +read, +bash` or `tools: +@builtin`.",
  extension_tools: "extension_tools is obsolete; list extension tools in tools:, e.g. `tools: +codegraph_*, +@pi-web-access`.",
  exclude_extensions: "exclude_extensions is obsolete; add -<id> rules to extensions:, e.g. `extensions: +@all, -ulw`.",
  inherit_extensions: "inherit_extensions is obsolete; use `extensions: +@all` to load every extension or omit it to load none.",
  disallowed_tools: `disallowed_tools is invalid; ${DISALLOWED_TOOLS_HINT}`,
  disallow_tools: `disallow_tools is invalid; ${DISALLOWED_TOOLS_HINT}`,
  skills: SKILLS_FIELD_MESSAGE,
  inherit_skills: SKILLS_FIELD_MESSAGE,
};

const MODE_EXTENSIONS_MESSAGE = "extensions: is not supported in Mode Agents (the main session cannot unload extensions); grant tools with tools: only.";

/** Parse markdown frontmatter using the shared agent schema. */
export function parseAgentMarkdown(content: string, options: ParseAgentOptions = {}): ParsedAgentFrontmatter {
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
  return parseAgentFrontmatter(frontmatter, body, options);
}

/** Parse already-extracted frontmatter using the shared agent schema. */
export function parseAgentFrontmatter(
  fm: Record<string, unknown>,
  body = "",
  options: ParseAgentOptions = {},
): ParsedAgentFrontmatter {
  const diagnostics: FrontmatterDiagnostic[] = [];
  for (const [field, message] of Object.entries(OBSOLETE_FIELD_MESSAGES)) {
    if (hasField(fm, field)) diagnostics.push({ field, severity: "error", message });
  }

  const toolsParsed = parseAccessRules("tools", fm.tools);
  diagnostics.push(...toolsParsed.diagnostics.map((d) => ({ field: "tools", ...d })));

  let extensionRules: AccessRule[] = [];
  if (options.kind === "mode") {
    if (hasField(fm, "extensions")) diagnostics.push({ field: "extensions", severity: "error", message: MODE_EXTENSIONS_MESSAGE });
  } else {
    const extensionsParsed = parseAccessRules("extensions", fm.extensions);
    extensionRules = extensionsParsed.rules;
    diagnostics.push(...extensionsParsed.diagnostics.map((d) => ({ field: "extensions", ...d })));
  }

  const invalidFields = [...new Set(diagnostics.filter((d) => d.severity === "error").map((d) => d.field))];

  return {
    frontmatter: fm,
    body,
    invalidFields,
    displayName: str(fm.display_name),
    description: str(fm.description),
    allowDelegationTo: csvListOptional(fm.allow_delegation_to),
    disallowDelegationTo: csvListOptional(fm.disallow_delegation_to),
    allowNesting: fm.allow_nesting === true,
    discoverSkills: parseDiscoverSkills(fm.discover_skills),
    preloadSkills: csvListOptional(fm.preload_skills) ?? [],
    model: str(fm.model),
    maxTurns: nonNegativeInt(fm.max_turns),
    promptMode: parsePromptMode(fm.prompt_mode),
    inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
    runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
    isolated: fm.isolated != null ? fm.isolated === true : undefined,
    enabled: fm.enabled !== false,
    toolRules: toolsParsed.rules,
    extensionRules,
    diagnostics,
  };
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

function parseCsvField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const s = String(val).trim();
  if (!s || s === "none") return undefined;
  const items = s.split(",").map((t) => t.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function csvListOptional(val: unknown): string[] | undefined {
  return parseCsvField(val);
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
