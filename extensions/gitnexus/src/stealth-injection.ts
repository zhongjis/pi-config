import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface BuildInjectedSystemPromptArgs {
  base: string;
  cwd: string;
  skills?: Array<{ name: string }>;
}

/**
 * Walk up ancestors from `cwd` looking for a `.gitnexus/` directory.
 * Uncached on purpose: `before_agent_start` fires once per agent start, and an
 * uncached check keeps this module trivially testable (the production cached
 * `findGitNexusIndex` in gitnexus.ts would bleed across test cases that share
 * a cwd). Semantically identical to `findGitNexusIndex(cwd)`.
 */
function hasGitNexusIndex(cwd: string): boolean {
  let dir = cwd;
  while (true) {
    if (existsSync(resolve(dir, '.gitnexus'))) return true;
    const parent = resolve(dir, '..');
    if (parent === dir) return false;
    dir = parent;
  }
}

// Prose-only. No filesystem paths, no skill names. Skill list is derived at runtime.
export const GITNEXUS_CONTRACT_PROSE = `# GitNexus — Code Intelligence

GitNexus indexes this codebase as a knowledge graph. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run \`/gitnexus analyze\` to rebuild it.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run \`gitnexus_impact({target: "symbolName", direction: "upstream"})\` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run \`gitnexus_detect_changes()\` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use \`gitnexus_query({query: "concept"})\` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use \`gitnexus_context({name: "symbolName"})\`.

## Never Do

- NEVER edit a function, class, or method without first running \`gitnexus_impact\` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use \`gitnexus_rename\` which understands the call graph.
- NEVER commit changes without running \`gitnexus_detect_changes()\` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| \`gitnexus://repos\` | List all indexed repositories |
| \`gitnexus://repo/{name}/context\` | Codebase overview, check index freshness |
| \`gitnexus://repo/{name}/clusters\` | All functional areas |
| \`gitnexus://repo/{name}/processes\` | All execution flows |
| \`gitnexus://repo/{name}/process/{name}\` | Step-by-step execution trace |`;

/**
 * Build the systemPrompt to inject. Returns undefined when no index is present
 * (no injection). Otherwise returns base + prose + runtime-derived skill section.
 */
export function buildInjectedSystemPrompt(args: BuildInjectedSystemPromptArgs): string | undefined {
  if (!hasGitNexusIndex(args.cwd)) return undefined;

  const gitnexusSkills = (args.skills ?? []).filter(s => s.name.startsWith('gitnexus-'));

  let skillSection: string;
  if (gitnexusSkills.length === 0) {
    skillSection = '\n\n## Loaded Skills\n\nNo gitnexus-* skills currently loaded. If you expect them, run `scripts/sync-gitnexus-resources.sh` to refresh vendored skills against the installed binary.';
  } else {
    const names = gitnexusSkills.map(s => `- \`${s.name}\``).join('\n');
    skillSection = `\n\n## Loaded Skills\n\nThe following gitnexus skills are loaded and available by name:\n\n${names}`;
  }

  return args.base + '\n\n' + GITNEXUS_CONTRACT_PROSE + skillSection;
}

/**
 * Compose the argv passed to `spawn(bin, composeAnalyzeArgs(baseArgs, userRest))`.
 * Always prepends --skip-agents-md --no-stats. Never passes --skills.
 */
export function composeAnalyzeArgs(baseArgs: string[], userRest: string[] = []): string[] {
  return [...baseArgs, 'analyze', '--skip-agents-md', '--no-stats', ...userRest];
}

export interface DriftCheckArgs {
  vendoredVersion: string | undefined;
  binaryVersion: string | undefined;
}
export interface DriftNotice {
  message: string;
  severity: 'warning';
}

export function checkSkillDrift(args: DriftCheckArgs): DriftNotice | null {
  if (!args.vendoredVersion || !args.binaryVersion) return null;
  if (args.vendoredVersion === args.binaryVersion) return null;
  return {
    severity: 'warning',
    message: `[GitNexus] Vendored skills version ${args.vendoredVersion} differs from installed binary ${args.binaryVersion}. Run scripts/sync-gitnexus-resources.sh to refresh.`,
  };
}
