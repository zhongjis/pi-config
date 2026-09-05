/**
 * agent-file-toggle.ts — Pure helpers for the `/agents` file-editing operations:
 * locating an agent's .md file, toggling its `enabled:` frontmatter flag, and
 * serializing an AgentConfig back to frontmatter for eject.
 *
 * These live outside src/index.ts so they can be tested directly: the `/agents`
 * command handler is an ~890-line closure reached only through `registerCommand`,
 * which every test mocks.
 *
 * The read side of this data (src/custom-agents.ts) parses frontmatter with a
 * real YAML parser, so it honors `enabled: false` at any position in the block.
 * This module must agree with it, and splits the work accordingly:
 *
 * - Deciding whether a file is disabled is a *read*, so it calls that same parser
 *   (`isDisabledContent`) instead of mirroring it. A mirror has to be right about
 *   YAML's boolean spellings and about pi's fence scan, and a regex was wrong
 *   about both.
 * - *Editing* cannot go through the parser, because re-serializing a parsed
 *   document would reformat a file the README tells users to hand-author —
 *   discarding their comments, key order, and quoting. So the edits are line-wise
 *   and preserve everything they don't touch.
 *
 * That leaves removal best-effort: it recognizes a lowercase bare `false`, and
 * reports `changed: false` for the spellings it cannot rewrite, so the caller
 * refuses honestly rather than announcing a change it did not make.
 */

import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseAgentFrontmatter } from "./custom-agents.js";
import { BUILTIN_TOOL_NAMES } from "./agent-types.js";
import type { AgentConfig } from "./types.js";

export type AgentFileLocation = "project" | "workspace" | "personal";

export const projectAgentsDir = (cwd: string = process.cwd()) => join(cwd, ".pi", "agents");
export const workspaceAgentsDir = (cwd: string = process.cwd()) => join(cwd, ".agents", "agents");
export const personalAgentsDir = () => join(getAgentDir(), "agents");

/**
 * Find the file path of a custom agent by name, in discovery-precedence order
 * (project, workspace, then global). Mirrors the load-side precedence in
 * src/custom-agents.ts — if the two drift, `/agents` edits a file the loader
 * isn't reading.
 */
export function findAgentFile(
  name: string,
  cwd: string = process.cwd(),
): { path: string; location: AgentFileLocation } | undefined {
  const projectPath = join(projectAgentsDir(cwd), `${name}.md`);
  if (existsSync(projectPath)) return { path: projectPath, location: "project" };
  const workspacePath = join(workspaceAgentsDir(cwd), `${name}.md`);
  if (existsSync(workspacePath)) return { path: workspacePath, location: "workspace" };
  const personalPath = join(personalAgentsDir(), `${name}.md`);
  if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
  return undefined;
}

/**
 * Find the file behind a *loaded* agent, preferring the path the loader
 * actually read (`AgentConfig.sourcePath`) over the `<type>.md` guess.
 *
 * An agent's type comes from its frontmatter `name:` now, so the two can
 * disagree: `reviewer.md` declaring `name: code-reviewer` is loaded as
 * `code-reviewer`, and probing for `code-reviewer.md` finds nothing. That is
 * not a harmless miss — `/agents → Disable` would then take the no-file branch
 * and write a NEW `code-reviewer.md` stub, which loses to `reviewer.md` on
 * load, leaving the agent enabled while reporting success.
 *
 * The probe stays as the fallback: a built-in that was never ejected has no
 * `sourcePath`, and a path can go stale between a load and this call.
 */
export function locateAgentFile(
  name: string,
  sourcePath: string | undefined,
  cwd: string = process.cwd(),
): { path: string; location: AgentFileLocation } | undefined {
  if (sourcePath && existsSync(sourcePath)) {
    return { path: sourcePath, location: classifyAgentDir(sourcePath, cwd) };
  }
  return findAgentFile(name, cwd);
}

/**
 * Which discovery location a loaded agent's file came from. Only ever names
 * a directory in a confirmation prompt, so an unrecognized parent — which
 * loadCustomAgents cannot currently produce — reports as personal rather than
 * widening the type for a case that has no better answer.
 */
function classifyAgentDir(path: string, cwd: string): AgentFileLocation {
  if (path.startsWith(projectAgentsDir(cwd) + sep)) return "project";
  if (path.startsWith(workspaceAgentsDir(cwd) + sep)) return "workspace";
  return "personal";
}

export type DisableOutcome = "disabled" | "already-disabled" | "no-frontmatter";

/** A line that sets `enabled: false`, ignoring trailing whitespace / CR. */
const ENABLED_FALSE = /^enabled:[ \t]*false[ \t]*$/;
/** An opening or closing `---` fence line. */
const FENCE = /^---[ \t]*$/;

/**
 * Split a file into its frontmatter lines and everything else, agreeing with
 * what `parseAgentFrontmatter` (the load side) considers a frontmatter block —
 * including its BOM normalisation, which is why the fence test looks past one.
 * The BOM itself stays in `lines[0]`: it belongs to the file's encoding, not to
 * the block, and an edit must not strip it from the user's file.
 *
 * Lines keep their terminators, so an edit preserves the file's existing line
 * endings instead of rewriting CRLF to LF. Returns undefined when there is no
 * usable block.
 */
function splitFrontmatter(content: string):
  | { lines: string[]; openIdx: number; closeIdx: number; eol: string }
  | undefined {
  const lines = content.split(/(?<=\n)/);
  if (lines.length === 0) return undefined;
  // The BOM stays where it is — it belongs to the file, not the block — so the
  // fence test looks past it and every index below is unaffected.
  const bom = content.startsWith("\uFEFF");
  const first = (bom ? lines[0].slice(1) : lines[0]).replace(/\r?\n$/, "");
  if (!FENCE.test(first)) return undefined;
  const closeIdx = lines.findIndex((l, i) => i > 0 && FENCE.test(l.replace(/\r?\n$/, "")));
  if (closeIdx === -1) return undefined;
  return { lines, openIdx: 0, closeIdx, eol: lines[0].endsWith("\r\n") ? "\r\n" : "\n" };
}

/**
 * Does the loader consider this file disabled?
 *
 * Detection is a READ operation, so it asks the same parser the loader uses
 * rather than mirroring it with a regex — that mirror has to be right about
 * YAML's boolean spellings (`False`, `FALSE`, a trailing `# comment`, a quoted
 * key) *and* about pi's fence scan, which closes the block on any line starting
 * `---` and so ends it early on `----`. A throw means the file is already
 * unparseable, which is what the loader sees too: it skips the agent, so there
 * is no "disabled" state to report.
 */
export function isDisabledContent(content: string): boolean {
  try {
    return parseAgentFrontmatter<Record<string, unknown>>(content).frontmatter.enabled === false;
  } catch {
    return false;
  }
}

/**
 * Add `enabled: false` to a file's frontmatter.
 *
 * `outcome` distinguishes a real edit from a no-op so the caller can report
 * honestly instead of unconditionally claiming success.
 */
export function disableInContent(content: string): { content: string; outcome: DisableOutcome } {
  const block = splitFrontmatter(content);
  if (!block) return { content, outcome: "no-frontmatter" };
  if (isDisabledContent(content)) return { content, outcome: "already-disabled" };
  const lines = [...block.lines];
  lines.splice(1, 0, `enabled: false${block.eol}`);
  return { content: lines.join(""), outcome: "disabled" };
}

/**
 * Remove `enabled: false` from a file's frontmatter, wherever it appears in the
 * block — the loader honors the key at any position, so the two must agree or a
 * hand-authored agent can be disabled and never re-enabled.
 *
 * `changed` is false when the key wasn't found, so the caller can avoid
 * reporting "Enabled <name>" for a write that did nothing.
 */
export function enableInContent(content: string): { content: string; changed: boolean } {
  const block = splitFrontmatter(content);
  if (!block) return { content, changed: false };
  const kept = block.lines.filter(
    (l, i) => !(i > 0 && i < block.closeIdx && ENABLED_FALSE.test(l.replace(/\r?\n$/, ""))),
  );
  if (kept.length === block.lines.length) return { content, changed: false };
  return { content: kept.join(""), changed: true };
}

/** Is this the empty stub `/agents` writes when disabling a built-in default? */
export function isEmptyStub(content: string): boolean {
  return content.replace(/\r\n/g, "\n").trim() === "---\n---";
}

/** The answers `/agents → Create agent → Manual` collects, before serialization. */
export interface NewAgentInput {
  description: string;
  /** Wizard answer: "none", "all", or comma-separated built-in/custom tool names. */
  tools: string;
  /** `provider/modelId`, or undefined to inherit the parent's model. */
  model?: string;
  /** A pi thinking level, or undefined to inherit. */
  thinking?: string;
  systemPrompt: string;
}

/** Build current-schema frontmatter; JSON scalars/arrays are safe YAML values. */
export function buildNewAgentFile(input: NewAgentInput): string {
  const tools = input.tools === "all" ? BUILTIN_TOOL_NAMES
    : input.tools === "none" ? [] : input.tools.split(",").map(name => name.trim()).filter(Boolean);
  const extensionTools = tools.filter(name => !BUILTIN_TOOL_NAMES.includes(name));
  const fields = {
    description: input.description,
    builtin_tools: tools.filter(name => BUILTIN_TOOL_NAMES.includes(name)),
    extension_tools: extensionTools.length > 0 ? extensionTools : undefined,
    model: input.model,
    thinking: input.thinking,
    prompt_mode: "replace",
  };
  return `---\n${Object.entries(fields).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n${input.systemPrompt}\n`;
}

/** Serialize only fields consumed by the current loader, preserving explicit empty/false/zero values. */
export function serializeAgentFile(cfg: AgentConfig): string {
  const fields = {
    description: cfg.description,
    display_name: cfg.displayName,
    builtin_tools: cfg.builtinToolNames ?? BUILTIN_TOOL_NAMES,
    extension_tools: cfg.extensionToolNames,
    allow_delegation_to: cfg.allowDelegationTo,
    disallow_delegation_to: cfg.disallowDelegationTo,
    allow_nesting: cfg.allowNesting,
    extensions: cfg.extensions,
    exclude_extensions: cfg.excludeExtensions,
    discover_skills: cfg.discoverSkills,
    preload_skills: cfg.preloadSkills,
    model: cfg.model,
    thinking: cfg.thinking,
    max_turns: cfg.maxTurns,
    persist_session: cfg.persistSession,
    output_transcript: cfg.outputTranscript,
    session_dir: cfg.sessionDir,
    prompt_mode: cfg.promptMode,
    inherit_context: cfg.inheritContext,
    run_in_background: cfg.runInBackground,
    isolated: cfg.isolated,
    enabled: cfg.enabled,
  };
  return `---\n${Object.entries(fields).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n${cfg.systemPrompt}\n`;
}
