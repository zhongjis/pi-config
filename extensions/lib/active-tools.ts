/**
 * Shared active-tool policy for mode and subagent sessions.
 *
 * Active tool names are strings. `extensions` controls whether extension tools
 * are available; `extensionTools` is the post-load extension-tool filter.
 */

export const DEFAULT_BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export const NESTED_SUBAGENT_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"] as const;

export type ExtensionSelection = true | readonly string[] | false;
export type ExtensionToolSelection = readonly string[] | false | undefined;

export interface ComputeActiveToolNamesInput {
  /** Tool names currently available from the session/runtime. Output order follows this list. */
  availableToolNames: readonly string[];
  /** Selected built-in tool names after parser/default resolution. */
  builtinToolNames: readonly string[];
  /** Canonical built-in names; values outside this set are never granted as built-ins. */
  builtinToolUniverse: readonly string[];
  /** false disables extension tools; true/string[] means extension tools are available after loading. */
  extensions: ExtensionSelection;
  /** undefined = all available extension tools; false/[] = none; string[] = exact tool names or `_*` suffix wildcards. */
  extensionTools?: ExtensionToolSelection;
  /** false removes nested subagent tools even if extension tool policy would otherwise include them. */
  allowNesting?: boolean;
  /** true disables all extension tools regardless of extensions/extensionTools settings. */
  isolated?: boolean;
}

/**
 * Compute final active tool names for an agent-like runtime.
 *
 * This function intentionally has no denylist or legacy `tools:` input.
 * Obsolete tool-selection fields are parser errors before runtime.
 */
export function computeActiveToolNames(input: ComputeActiveToolNamesInput): string[] {
  const builtinUniverse = new Set(input.builtinToolUniverse);
  const selectedBuiltins = new Set(
    input.builtinToolNames.filter((name) => builtinUniverse.has(name)),
  );
  const selectedExtensionTools = input.extensionTools === undefined || input.extensionTools === false
    ? input.extensionTools
    : new Set(input.extensionTools);
  const extensionsEnabled = input.isolated !== true
    && input.extensions !== false
    && input.extensionTools !== false;
  const seen = new Set<string>();
  const activeToolNames: string[] = [];

  for (const name of input.availableToolNames) {
    if (seen.has(name)) continue;
    seen.add(name);

    if (NESTED_SUBAGENT_TOOL_NAMES.includes(name as typeof NESTED_SUBAGENT_TOOL_NAMES[number]) && input.allowNesting !== true) {
      continue;
    }

    if (builtinUniverse.has(name)) {
      if (selectedBuiltins.has(name)) activeToolNames.push(name);
      continue;
    }

    if (!extensionsEnabled) continue;
    if (selectedExtensionTools instanceof Set && !matchesExtensionToolSelection(selectedExtensionTools, name)) continue;

    activeToolNames.push(name);
  }

  return activeToolNames;
}

function matchesExtensionToolSelection(selection: ReadonlySet<string>, name: string): boolean {
  if (selection.has(name)) return true;

  for (const pattern of selection) {
    if (pattern.endsWith("_*") && name.startsWith(pattern.slice(0, -1))) return true;
  }

  return false;
}
