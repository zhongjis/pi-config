/**
 * prompts.ts — System prompt builder for agents.
 */

import type { AgentConfig, EnvInfo } from "./types.js";

export const SUBAGENT_COMMUNICATION_CONTRACT = `# Parent/subagent communication
Parent: Use the subagents extension to delegate, steer, collect results,
and resume. Handle coordination with other sessions yourself.

Subagent: Return results, questions, and blockers to the parent.
If a required capability is missing, report it rather than seeking
another communication channel or alternate access.`;

/** Extra sections to inject into the system prompt (skills, etc.). */
export interface PromptExtras {
  /** Preloaded skill contents to inject. */
  skillBlocks?: { name: string; content: string; sourcePath?: string; baseDir?: string }[];
}

/** Build the agent's own instructions, environment, communication contract, and preloaded skills. */
export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  extras?: PromptExtras,
): string {
  const activeAgentTag = `<active_agent name="${config.name}"/>\n\n`;

  const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;

  // Build optional extras suffix
  const extraSections: string[] = [SUBAGENT_COMMUNICATION_CONTRACT];
  if (extras?.skillBlocks?.length) {
    for (const skill of extras.skillBlocks) {
      const sourceLine = skill.sourcePath ? `Source: ${skill.sourcePath}\n` : "";
      const baseDirLine = skill.baseDir ? `Skill directory: ${skill.baseDir}\nRelative references resolve from this skill directory.\n` : "";
      extraSections.push(`\n# Preloaded Skill: ${skill.name}\n${sourceLine}${baseDirLine}${skill.content}`);
    }
  }
  const extrasSuffix = extraSections.length > 0 ? "\n\n" + extraSections.join("\n") : "";

  // "replace" / "system_instructions" mode — env header + the config's full system prompt.
  const replaceHeader = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

${envBlock}`;

  return activeAgentTag + replaceHeader + "\n\n" + config.systemPrompt + extrasSuffix;
}

