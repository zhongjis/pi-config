/**
 * skill-loader.ts — Preload specific skill files and inject their content into the system prompt.
 *
 * When skills is a string[], reads each named skill from .pi/skills/ or ~/.pi/skills/
 * and returns their content for injection into the agent's system prompt.
 */
export interface PreloadedSkill {
    name: string;
    content: string;
}
/**
 * Attempt to load named skills from project and global skill directories.
 * Looks for: <dir>/<name>.md, <dir>/<name>.txt, <dir>/<name>
 *
 * @param skillNames  List of skill names to preload.
 * @param cwd         Working directory for project-level skills.
 * @returns Array of loaded skills (missing skills are skipped with a warning comment).
 */
export declare function preloadSkills(skillNames: string[], cwd: string): PreloadedSkill[];
