/**
 * skill-loader.ts — Preload specific skill files and inject their content into the system prompt.
 *
 * When skills is a string[], reads each named skill from Pi skill locations and
 * returns their content for injection into the agent's system prompt.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isUnsafeName, safeReadFile } from "./memory.js";
/**
 * Attempt to load named skills from project and global skill directories.
 * Supports Pi directory skills (`<name>/SKILL.md`) plus legacy flat files.
 *
 * @param skillNames  List of skill names to preload.
 * @param cwd         Working directory for project-level skills.
 * @returns Array of loaded skills (missing skills are skipped with a warning comment).
 */
export function preloadSkills(skillNames, cwd) {
    const results = [];
    for (const name of skillNames) {
        // Unlike memory (which throws on unsafe names because it's part of agent setup),
        // skills are optional — skip gracefully to avoid blocking agent startup.
        if (isUnsafeName(name)) {
            results.push({ name, content: `(Skill "${name}" skipped: name contains path traversal characters)` });
            continue;
        }
        const loaded = findAndReadSkill(name, cwd);
        if (loaded !== undefined) {
            results.push({ name, content: loaded.content, sourcePath: loaded.sourcePath, baseDir: loaded.baseDir });
        }
        else {
            // Include a note about missing skills so the agent knows it was requested but not found.
            results.push({ name, content: `(Skill "${name}" not found in Pi skill locations)` });
        }
    }
    return results;
}
/**
 * Search for a skill file in Pi project and global directories.
 * Project-level takes priority over global.
 */
function findAndReadSkill(name, cwd) {
    for (const dir of getSkillSearchDirs(cwd)) {
        const loaded = tryReadSkillFile(dir, name);
        if (loaded !== undefined)
            return loaded;
    }
    return undefined;
}
/**
 * Return Pi skill search directories relevant for named preloading.
 * Mirrors standard locations enough for subagents while preserving legacy ~/.pi/skills.
 */
function getSkillSearchDirs(cwd) {
    const dirs = [
        { dir: join(cwd, ".pi", "skills"), includeRootFiles: true },
        ...getAncestorAgentSkillDirs(cwd).map((dir) => ({ dir, includeRootFiles: false })),
        { dir: join(homedir(), ".pi", "agent", "skills"), includeRootFiles: true },
        { dir: join(homedir(), ".agents", "skills"), includeRootFiles: false },
        { dir: join(homedir(), ".pi", "skills"), includeRootFiles: true },
    ];
    const seen = new Set();
    return dirs.filter(({ dir }) => {
        const key = resolve(dir);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
/**
 * Project `.agents/skills` are discovered from cwd and ancestors until the git root.
 */
function getAncestorAgentSkillDirs(cwd) {
    const dirs = [];
    let current = resolve(cwd);
    while (true) {
        dirs.push(join(current, ".agents", "skills"));
        if (existsSync(join(current, ".git")))
            break;
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return dirs;
}
/**
 * Try to read a named skill from a search directory.
 * Mirrors Pi discovery: recursive directory `SKILL.md`, root `.md` files only in Pi skill dirs.
 */
function tryReadSkillFile(searchDir, name) {
    for (const sourcePath of collectSkillFiles(searchDir.dir, searchDir.includeRootFiles)) {
        const loaded = readSkill(sourcePath);
        if (loaded !== undefined && getSkillName(sourcePath, loaded.content) === name)
            return loaded;
    }
    return undefined;
}
function collectSkillFiles(dir, includeRootFiles) {
    const files = [];
    collectSkillFilesInternal(dir, includeRootFiles, dir, files);
    return files;
}
function collectSkillFilesInternal(dir, includeRootFiles, rootDir, files) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    const skillPath = join(dir, "SKILL.md");
    if (entries.some((entry) => entry.name === "SKILL.md" && isReadableFile(skillPath))) {
        files.push(skillPath);
        return;
    }
    for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules")
            continue;
        const entryPath = join(dir, entry.name);
        const kind = getEntryKind(entryPath, entry);
        if (kind === "directory") {
            collectSkillFilesInternal(entryPath, false, rootDir, files);
            continue;
        }
        if (kind === "file" && includeRootFiles && dir === rootDir && entry.name.endsWith(".md")) {
            files.push(entryPath);
        }
    }
}
function isReadableFile(path) {
    return getFileContent(path) !== undefined;
}
function getEntryKind(path, entry) {
    if (!entry.isSymbolicLink()) {
        if (entry.isDirectory())
            return "directory";
        if (entry.isFile())
            return "file";
        return "other";
    }
    try {
        const stats = statSync(path);
        if (stats.isDirectory())
            return "directory";
        if (stats.isFile())
            return "file";
    }
    catch {
        return "other";
    }
    return "other";
}
function readSkill(sourcePath) {
    const content = getFileContent(sourcePath);
    if (content === undefined)
        return undefined;
    return { content: content.trim(), sourcePath, baseDir: dirname(sourcePath) };
}
function getFileContent(sourcePath) {
    // safeReadFile rejects symlinks to prevent reading arbitrary files.
    return safeReadFile(sourcePath);
}
function getSkillName(sourcePath, content) {
    return parseFrontmatterName(content) ?? inferSkillNameFromPath(sourcePath);
}
function parseFrontmatterName(content) {
    if (!content.startsWith("---"))
        return undefined;
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!match)
        return undefined;
    for (const line of match[1].split(/\r?\n/)) {
        const nameMatch = /^name:\s*["']?([^"'#\r\n]+)["']?\s*(?:#.*)?$/.exec(line.trim());
        if (nameMatch)
            return nameMatch[1].trim();
    }
    return undefined;
}
function inferSkillNameFromPath(sourcePath) {
    if (basename(sourcePath) === "SKILL.md")
        return basename(dirname(sourcePath));
    return basename(sourcePath).replace(/\.(md|txt)$/i, "");
}
