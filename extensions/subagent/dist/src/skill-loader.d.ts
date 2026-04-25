/**
 * skill-loader.ts — Preload specific skill files and inject their content into the system prompt.
 *
 * When skills is a string[], reads each named skill from Pi skill locations and
 * returns their content for injection into the agent's system prompt.
 */
export interface PreloadedSkill {
    name: string;
    content: string;
    sourcePath?: string;
    baseDir?: string;
}
/**
 * Attempt to load named skills from project and global skill directories.
 * Supports Pi directory skills (`<name>/SKILL.md`) plus legacy flat files.
 *
 * @param skillNames  List of skill names to preload.
 * @param cwd         Working directory for project-level skills.
 * @returns Array of loaded skills (missing skills are skipped with a warning comment).
 */
export declare function preloadSkills(skillNames: string[], cwd: string): PreloadedSkill[];
