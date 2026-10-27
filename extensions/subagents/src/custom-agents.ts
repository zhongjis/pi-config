/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/, plus the shared .agents/agents/ workspace) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ParsedAgentFrontmatter, parseAgentMarkdown } from "../../lib/agent-frontmatter.js";
import { type PromptVariants, readPromptVariantDir } from "../../lib/prompt-variants.js";
import { normalizeThinkingLevel } from "./thinking-level.js";
import type {
  AgentConfig,
  AgentDefinitionDiagnostic,
  CustomAgentsLoadResult,
} from "./types.js";

/** Load flat .md and directory default.md agent definitions from the configured locations. */
export function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
  return loadCustomAgentsWithDiagnostics(cwd).agents;
}

interface DefinitionCandidate {
  readonly path: string;
  readonly directory?: string;
  readonly source: "project" | "global";
}

/** Scan names first, then resolve each name from its highest-priority valid definition. */
export function loadCustomAgentsWithDiagnostics(cwd: string): CustomAgentsLoadResult {
  const candidates = new Map<string, DefinitionCandidate[]>();
  for (const [dir, source] of [
    [join(cwd, ".pi", "agents"), "project"],
    [join(cwd, ".agents", "agents"), "project"],
    [join(getAgentDir(), "agents"), "global"],
  ] as const) {
    let files: string[];
    try {
      files = readdirSync(dir).filter(file => file !== "AGENTS.md");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error;
      continue;
    }
    const names = new Set(files.map(file => file.endsWith(".md") ? basename(file, ".md") : file));
    for (const name of names) {
      const entries = candidates.get(name) ?? [];
      const directory = join(dir, name);
      const defaultPath = join(directory, "default.md");
      if (existsSync(defaultPath)) entries.push({ path: defaultPath, directory, source });
      const flatPath = join(dir, `${name}.md`);
      if (existsSync(flatPath)) entries.push({ path: flatPath, source });
      if (entries.length > 0) candidates.set(name, entries);
    }
  }

  const agents = new Map<string, AgentConfig>();
  const diagnostics: AgentDefinitionDiagnostic[] = [];
  for (const [name, entries] of candidates) {
    const invalidPaths: string[] = [];
    let usedPath: string | undefined;
    for (const candidate of entries) {
      try {
        const definition = candidate.directory
          ? readPromptVariantDir(candidate.directory)
          : { defaultContent: readFileSync(candidate.path, "utf-8"), variants: undefined };
        if (!definition) {
          diagnostics.push({ file: candidate.path, agentName: name, field: "definition", severity: "error", message: "Cannot read definition." });
        } else {
          const parsed = parseAgentMarkdown(definition.defaultContent);
          diagnostics.push(...parsed.diagnostics.map(diagnostic => ({ file: candidate.path, agentName: name, ...diagnostic })));
          if (parsed.invalidFields.length === 0) {
            agents.set(name, { ...toAgentConfig(name, parsed, candidate.source, definition.variants), definitionPath: candidate.path });
            usedPath = candidate.path;
            break;
          }
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        diagnostics.push({ file: candidate.path, agentName: name, field: "definition", severity: "error", message: error.message });
      }
      invalidPaths.push(candidate.path);
    }
    if (usedPath) {
      for (const file of invalidPaths) diagnostics.push({ file, agentName: name, severity: "warning", message: `invalid definition; using ${usedPath}` });
    } else {
      diagnostics.push({ agentName: name, severity: "warning", message: "no valid definition; agent unavailable" });
    }
  }
  return { agents, diagnostics };
}

/** Convert a valid parsed definition into its runtime agent config. */
export function toAgentConfig(name: string, parsed: ParsedAgentFrontmatter, source: AgentConfig["source"], promptVariants?: PromptVariants): AgentConfig {
  // NEW-local fields the shared schema does not model. Parsed directly from
  // the raw frontmatter. `thinking` is normalized (legacy "none" -> "off")
  // via the shared thinking-level helper.
  const fm = parsed.frontmatter;

  return {
    name,
    displayName: parsed.displayName,
    description: parsed.description ?? name,
    extensionRules: parsed.extensionRules,
    toolRules: parsed.toolRules,
    delegationRules: parsed.delegationRules,
    discoverSkills: parsed.discoverSkills,
    preloadSkills: parsed.preloadSkills,
    model: parsed.model,
    thinking: normalizeThinkingLevel(str(fm.thinking)),
    outputTranscript: fm.output_transcript != null ? fm.output_transcript !== false : undefined,
    sessionDir: str(fm.session_dir),
    systemPrompt: parsed.body.trim(),
    promptVariants,
    promptMode: parsed.promptMode,
    inheritContext: parsed.inheritContext,
    runInBackground: parsed.runInBackground,
    isolated: parsed.isolated,
    enabled: parsed.enabled,
    source,
  };
}

/** Extract a string or undefined. */
function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}
