/**
 * Shared `extensions:`/`tools:` access policy for Mode Agent and Subagent sessions.
 *
 * Both frontmatter fields are ordered lists of signed rules (`+selector` /
 * `-selector`). Lists start empty and the last matching rule wins. This
 * module owns rule parsing, group/glob matching, resolution against the live
 * registry, hard gates, extension identity, and the tool ceiling.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { extractToolText, firstMeaningfulLine, renderToolCall, renderToolExpanded, renderToolSummary } from "./tool-output.js";

export const NESTED_SUBAGENT_TOOL_NAMES = ["agent", "get_agent_result", "resolve_agent_graph_gate", "steer_subagent"] as const;

// ponytail: copy of Pi's internal built-in tool name list. Pi does not export
// `ToolName`/`allToolNames`, so this is hand-maintained. Add new Pi built-ins
// here when upgrading Pi.
export const BUILTIN_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;

export function isBuiltinToolName(name: string): boolean {
  return (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}

/** Fu Xi-only plan tools. Granted only through the `planTools` hard gate. */
export const PLAN_TOOL_NAMES = ["plan_approve", "plan_scaffold"] as const;

export type AccessRuleField = "tools" | "extensions";

export interface AccessRule {
  readonly sign: "+" | "-";
  readonly selector: string;
}

export interface AccessDiagnostic {
  readonly severity: "error" | "warning";
  readonly message: string;
}

const RESERVED_TOOL_GROUP_WORDS = new Set(["read", "write", "package", "project", "user"]);

/**
 * Parse a `tools:`/`extensions:` frontmatter value into signed rules.
 *
 * `undefined`/`null` and an empty list both mean "nothing" (no implicit
 * rules). A string value is split on `,`; an array must contain only
 * strings. Boolean values are always an error (the old `extensions: true`
 * contract is obsolete). Every other non-string, non-array value is an
 * error naming the required shape.
 */
export function parseAccessRules(field: AccessRuleField, value: unknown): { rules: AccessRule[]; diagnostics: AccessDiagnostic[] } {
  const diagnostics: AccessDiagnostic[] = [];
  if (value === undefined || value === null) return { rules: [], diagnostics };

  if (typeof value === "boolean") {
    if (field === "extensions") {
      diagnostics.push({
        severity: "error",
        message: 'boolean extensions is obsolete; use "extensions: +@all" to load every extension or omit the field to load none.',
      });
    } else {
      diagnostics.push({ severity: "error", message: `${field} must be a list of signed rules (+selector / -selector).` });
    }
    return { rules: [], diagnostics };
  }

  let entries: string[];
  if (typeof value === "string") {
    entries = value.split(",");
  } else if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === "string")) {
      diagnostics.push({ severity: "error", message: `${field} must be a list of signed rules (+selector / -selector).` });
      return { rules: [], diagnostics };
    }
    entries = value as string[];
  } else {
    diagnostics.push({ severity: "error", message: `${field} must be a list of signed rules (+selector / -selector).` });
    return { rules: [], diagnostics };
  }

  const rules: AccessRule[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;

    const sign = entry[0];
    if (sign !== "+" && sign !== "-") {
      diagnostics.push({ severity: "error", message: `unsigned entry "${entry}": prefix + to grant or - to remove, e.g. "+${entry}"` });
      continue;
    }

    let selector = entry.slice(1).trim();
    if (!selector || /[\s()]/.test(selector)) {
      diagnostics.push({ severity: "error", message: `invalid selector "${entry}": a selector must be non-empty and contain no whitespace or parentheses.` });
      continue;
    }

    if (field === "extensions") {
      selector = selector.toLowerCase();
      if (selector.startsWith("@")) {
        const group = selector.slice(1);
        if (group !== "all" && group !== "builtin") {
          diagnostics.push({ severity: "error", message: `unknown group "@${group}": extensions only supports @all and @builtin.` });
          continue;
        }
      } else if (selector === "all" || selector === "builtin") {
        diagnostics.push({ severity: "error", message: `"${selector}" is a reserved word; use "@${selector}" instead.` });
        continue;
      } else if (/[/\\]/.test(selector) || selector.startsWith("~") || selector.startsWith(".")) {
        diagnostics.push({ severity: "error", message: `"${selector}" looks like a path; use the extension id, not a path.` });
        continue;
      }
    } else if (selector.startsWith("@")) {
      selector = selector.toLowerCase();
      const group = selector.slice(1);
      if (!group) {
        diagnostics.push({ severity: "error", message: '"@" is not a valid selector; name a group such as "@all" or "@builtin", or an extension id.' });
        continue;
      }
      if (group.includes("*")) {
        diagnostics.push({ severity: "error", message: `"@${group}" cannot use a glob; groups take no globs.` });
        continue;
      }
      if (group !== "all" && group !== "builtin" && (RESERVED_TOOL_GROUP_WORDS.has(group) || group.startsWith("mcp:"))) {
        diagnostics.push({ severity: "error", message: `"@${group}" is reserved for future use.` });
        continue;
      }
    }

    rules.push({ sign, selector });
  }

  if (rules.length > 0 && rules[0].sign === "-") {
    diagnostics.push({ severity: "warning", message: `leading "-${rules[0].selector}" removes nothing from the empty start.` });
  }

  return { rules, diagnostics };
}

/** Format rules back to their `+selector, -selector` display form. */
export function formatAccessRules(rules: readonly AccessRule[]): string {
  return rules.map((r) => `${r.sign}${r.selector}`).join(", ");
}

function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `*` matches any run of characters, including empty; every other character is literal. */
export function matchesNameOrGlob(selector: string, value: string): boolean {
  if (!selector.includes("*")) return selector === value;
  const pattern = selector.split("*").map(escapeRegExpLiteral).join(".*");
  return new RegExp(`^${pattern}$`).test(value);
}

export interface ExtensionCandidate {
  /** The extension's path (the resolution key). */
  readonly key: string;
  /** Lowercased identities this extension answers to. */
  readonly ids: readonly string[];
}

/**
 * Fold `extensions:` rules against the live extension registry.
 *
 * `@all` matches everything; `@builtin` matches candidates with a
 * `builtin:`-prefixed id; any other selector is an id or glob matched
 * against each candidate's `ids`. The last rule matching a candidate decides
 * whether it is included.
 */
export function resolveExtensionAccess(
  rules: readonly AccessRule[],
  candidates: readonly ExtensionCandidate[],
): { selected: Set<string>; diagnostics: AccessDiagnostic[] } {
  const diagnostics: AccessDiagnostic[] = [];
  const selected = new Set<string>();

  for (const rule of rules) {
    const matchedKeys = new Set<string>();

    if (rule.selector === "@all") {
      for (const c of candidates) matchedKeys.add(c.key);
    } else if (rule.selector === "@builtin") {
      for (const c of candidates) if (c.ids.some((id) => id.startsWith("builtin:"))) matchedKeys.add(c.key);
    } else {
      for (const c of candidates) if (c.ids.some((id) => matchesNameOrGlob(rule.selector, id))) matchedKeys.add(c.key);

      if (!rule.selector.includes("*") && matchedKeys.size > 1) {
        diagnostics.push({ severity: "error", message: `"${rule.selector}" is ambiguous: matches ${[...matchedKeys].sort().join(", ")}` });
        matchedKeys.clear();
      } else if (matchedKeys.size === 0) {
        diagnostics.push({ severity: "warning", message: `"${rule.selector}" matches no extension` });
      }
    }

    for (const key of matchedKeys) {
      if (rule.sign === "+") selected.add(key);
      else selected.delete(key);
    }
  }

  return { selected, diagnostics };
}

export interface ToolCandidate {
  readonly name: string;
  /** `sourceInfo.path` of the tool's registration. */
  readonly source?: string;
  /** Lowercased extension identities; empty for built-in tool names. */
  readonly extensionIds: readonly string[];
}

export interface ToolAccessGates {
  readonly allowNesting?: boolean;
  readonly goalTools?: { readonly names: readonly string[]; readonly allowed: readonly string[] };
  readonly planTools?: boolean;
}

/** Trusted internal sources are always allowed, regardless of rules and gates. */
export function isTrustedToolSource(source: string | undefined): boolean {
  return source !== undefined && (source.startsWith("<inline:") || source.startsWith("<sdk:"));
}

function denyUnlessTrusted(allowed: Set<string>, tools: readonly ToolCandidate[], name: string): void {
  const tool = tools.find((t) => t.name === name);
  if (tool && isTrustedToolSource(tool.source)) return;
  allowed.delete(name);
}

/**
 * Fold `tools:` rules against the live tool registry, then apply hard gates.
 *
 * `@all` matches every tool; `@builtin` matches by built-in name regardless
 * of source; `@<id>` matches non-built-in tools whose `extensionIds` include
 * `id`; a name or glob matches the tool name. Gates run after the fold, in
 * order: trusted sources, nested-subagent denial, goal-tool gate, plan-tool
 * gate.
 */
export function resolveToolAccess(
  rules: readonly AccessRule[],
  tools: readonly ToolCandidate[],
  gates?: ToolAccessGates,
): { allowed: Set<string>; diagnostics: AccessDiagnostic[] } {
  const diagnostics: AccessDiagnostic[] = [];
  const allowed = new Set<string>();

  const usesReservedGroup = rules.some((r) => r.selector === "@all" || r.selector === "@builtin");
  if (usesReservedGroup) {
    const collisions = new Set<string>();
    for (const t of tools) for (const id of t.extensionIds) if (id === "all" || id === "builtin") collisions.add(id);
    for (const id of [...collisions].sort()) {
      diagnostics.push({
        severity: "error",
        message: `extension id "${id}" collides with the reserved group word "@${id}"; the group keeps its meaning.`,
      });
    }
  }

  for (const rule of rules) {
    const matchedNames = new Set<string>();

    if (rule.selector === "@all") {
      for (const t of tools) matchedNames.add(t.name);
    } else if (rule.selector === "@builtin") {
      for (const t of tools) if (isBuiltinToolName(t.name)) matchedNames.add(t.name);
    } else if (rule.selector.startsWith("@")) {
      const id = rule.selector.slice(1);
      const matchedSources = new Set<string | undefined>();
      for (const t of tools) {
        if (isBuiltinToolName(t.name)) continue;
        if (t.extensionIds.includes(id)) {
          matchedNames.add(t.name);
          matchedSources.add(t.source);
        }
      }
      if (matchedSources.size > 1) {
        diagnostics.push({ severity: "error", message: `"@${id}" is ambiguous: matches ${[...matchedSources].map((s) => s ?? "<unknown>").sort().join(", ")}` });
        matchedNames.clear();
      } else if (matchedNames.size === 0) {
        diagnostics.push({ severity: "warning", message: `"@${id}" matches no tool` });
      }
    } else {
      for (const t of tools) if (matchesNameOrGlob(rule.selector, t.name)) matchedNames.add(t.name);
    }

    for (const name of matchedNames) {
      if (rule.sign === "+") allowed.add(name);
      else allowed.delete(name);
    }
  }

  // (a) trusted sources are always allowed, regardless of rules and gates.
  for (const t of tools) if (isTrustedToolSource(t.source)) allowed.add(t.name);

  // (b) nested subagent controls require allowNesting.
  if (gates?.allowNesting !== true) {
    for (const name of NESTED_SUBAGENT_TOOL_NAMES) denyUnlessTrusted(allowed, tools, name);
  }

  // (c) goal tools require goal access.
  if (gates?.goalTools) {
    const goalAllowed = new Set(gates.goalTools.allowed);
    for (const name of gates.goalTools.names) {
      if (!goalAllowed.has(name)) denyUnlessTrusted(allowed, tools, name);
    }
  }

  // (d) Fu Xi-only plan tools.
  if (gates?.planTools === true) {
    for (const name of PLAN_TOOL_NAMES) if (tools.some((t) => t.name === name)) allowed.add(name);
  } else if (gates?.planTools === false) {
    for (const name of PLAN_TOOL_NAMES) denyUnlessTrusted(allowed, tools, name);
  }

  return { allowed, diagnostics };
}

/**
 * Always-active, model-only policy tool that hides its own declaration plus
 * every declared tool the allowlist does not grant. `allowedToolNames` is
 * called once per `prepareLoadout` invocation.
 */
export function createToolCeilingTool(name: string, allowedToolNames: () => ReadonlySet<string>): ToolDefinition {
  return {
    name,
    label: "Tool access ceiling",
    description: "Internal tool-access ceiling. Never call this tool — it has no effect other than enforcing the agent's allowed tool set.",
    exposure: "model-only",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text" as const, text: "This tool is internal and must never be called." }], details: undefined };
    },
    renderCall(_args, theme) {
      return renderToolCall(name, undefined, theme);
    },
    renderResult(result, options, theme) {
      const raw = extractToolText(result);
      if (options.expanded) return renderToolExpanded(raw);
      return renderToolSummary([firstMeaningfulLine(raw) || "internal tool"], theme, { expandable: true, expandLabel: "full result" });
    },
    prepareLoadout(loadout) {
      const allowed = allowedToolNames();
      return {
        hiddenDeclarations: loadout.declared
          .map((t) => t.name)
          .filter((n) => n === name || !allowed.has(n)),
      };
    },
  };
}

/**
 * Canonical name of an extension for allowlist matching (lowercased).
 * Directory extensions (`foo/index.ts`) resolve to the parent directory
 * name; single-file extensions to the basename minus `.ts`/`.js`.
 */
export function extensionCanonicalName(extPath: string): string {
  const base = basename(extPath);
  const name = base === "index.ts" || base === "index.js"
    ? basename(dirname(extPath))
    : base.replace(/\.(ts|js)$/, "");
  return name.toLowerCase();
}

/**
 * The unscoped, lowercased npm short name of the pi package that DECLARES
 * `extPath` as an extension entry — or undefined if the entry doesn't belong to
 * such a package.
 *
 * Climbs from the entry's directory looking for the package that owns it, and
 * stays strictly within that package's tree by stopping at two structural
 * boundaries — no hardcoded depth:
 *   - the FIRST `package.json` found (the package root); the entry's own
 *     manifest always sits at the root, above the entry, below any node_modules.
 *   - a `node_modules` directory: a package never spans one (it's where OTHER
 *     packages live), so reaching it means we've climbed out of the package —
 *     stop before reading a consumer's or parent package's manifest.
 * The name is then taken only when that root's `pi.extensions` manifest actually
 * lists this entry. That "declares this entry" check is deliberate: a repo whose
 * root manifest declares `./src/index.ts` for its own package would otherwise
 * misattribute every co-located file to that package.
 */
function extensionPackageName(extPath: string): string | undefined {
  const entry = resolve(extPath);
  let dir = dirname(extPath);
  for (;;) {
    // Climbing into node_modules means we've left the owning package's tree.
    if (basename(dir) === "node_modules") return undefined;
    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined; // walked to the filesystem root
      dir = parent;
      continue;
    }
    // First package.json wins — it's the package root; decide here.
    const entries = pkg.pi?.extensions;
    if (
      typeof pkg.name === "string" &&
      Array.isArray(entries) &&
      entries.some((e) => typeof e === "string" && resolve(dir, e) === entry)
    ) {
      const short = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
      return short.toLowerCase();
    }
    return undefined;
  }
}

/**
 * All names an extension answers to for allowlist matching (lowercased): its
 * path-derived {@link extensionCanonicalName} plus, when a pi package manifest
 * declares this entry, that package's unscoped short name (`@scope/foo` → `foo`).
 * An extension installed via `pi.extensions: ["./src/index.ts"]` would
 * otherwise only ever match as `src` (the source directory), never by its
 * package name. The path-derived name is preserved, so it keeps matching too.
 */
export function extensionCanonicalNames(extPath: string): string[] {
  const canonical = extensionCanonicalName(extPath);
  const pkg = extensionPackageName(extPath);
  return pkg && pkg !== canonical ? [canonical, pkg] : [canonical];
}

const extensionIdsCache = new Map<string, string[]>();

/**
 * Extension identities for a tool/extension `sourceInfo.path`. A `builtin:`
 * path gives its own lowercased value; a trusted `<inline:`/`<sdk:` synthetic
 * path gives none; everything else resolves through {@link extensionCanonicalNames},
 * memoized per path because the package lookup reads disk.
 */
export function extensionIdsForPath(path: string): string[] {
  if (path.startsWith("builtin:")) return [path.toLowerCase()];
  if (path.startsWith("<inline:") || path.startsWith("<sdk:")) return [];

  const cached = extensionIdsCache.get(path);
  if (cached) return cached;

  const ids = extensionCanonicalNames(path);
  extensionIdsCache.set(path, ids);
  return ids;
}

/**
 * Build {@link ToolCandidate}s from the live tool registry. Built-in tool
 * names always resolve to no extension ids; other tools resolve through
 * {@link extensionIdsForPath} from their `sourceInfo.path`, or none when the
 * tool carries no source path.
 */
export function toolCandidates(
  tools: readonly { name: string; sourceInfo?: { path?: string } }[],
): ToolCandidate[] {
  return tools.map((t) => {
    const path = t.sourceInfo?.path;
    if (isBuiltinToolName(t.name)) return { name: t.name, source: path, extensionIds: [] };
    return { name: t.name, source: path, extensionIds: path ? extensionIdsForPath(path) : [] };
  });
}

