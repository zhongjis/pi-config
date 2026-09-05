/**
 * skill-loader.ts — Preload named skills with source-relative provenance.
 *
 * Roots, in precedence order: cwd/.pi/skills, cwd and ancestor .agents/skills
 * through the git root, getAgentDir()/skills, ~/.agents/skills, ~/.pi/skills.
 * YAML name overrides directory name or flat-file stem. Flat files precede
 * directory skills; directory traversal is sorted breadth-first, never nested
 * inside a skill. Dot directories, node_modules and symlinks are excluded.
 */

import type { Dirent } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isSymlink, isUnsafeName, safeReadFile } from "./fs-safety.js";

export interface PreloadedSkill {
  name: string;
  content: string;
  sourcePath?: string;
  baseDir?: string;
}

export function preloadSkills(skillNames: string[], cwd: string): PreloadedSkill[] {
  return skillNames.map((name) => loadSkill(name, cwd));
}

function loadSkill(name: string, cwd: string): PreloadedSkill {
  if (isUnsafeName(name)) {
    return { name, content: `(Skill "${name}" skipped: name contains path traversal characters)` };
  }
  const roots = [join(resolve(cwd), ".pi", "skills")];
  let current = resolve(cwd);
  while (true) {
    roots.push(join(current, ".agents", "skills"));
    const parent = dirname(current);
    if (existsSync(join(current, ".git")) || parent === current) break;
    current = parent;
  }
  roots.push(
    join(getAgentDir(), "skills"),
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".pi", "skills"),
  );
  for (const root of new Set(roots)) {
    const skill = findInRoot(root, name);
    if (skill !== undefined) return skill;
  }
  return { name, content: `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)` };
}

function findInRoot(root: string, name: string): PreloadedSkill | undefined {
  if (isSymlink(root)) return undefined;
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    // Deterministic byte-order traversal — locale-independent.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    if (current === root) {
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(".md")) continue;
        const skill = readSkill(join(current, entry.name), name);
        if (skill !== undefined) return skill;
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      // Dirent uses lstat semantics, so symlinked directories are excluded.
      const path = join(current, entry.name);
      const skillMd = join(path, "SKILL.md");
      if (existsSync(skillMd)) {
        const skill = readSkill(skillMd, name);
        if (skill !== undefined) return skill;
        continue; // Skills don't nest, even when this skill has another name.
      }
      queue.push(path);
    }
  }
  return undefined;
}

function readSkill(sourcePath: string, name: string): PreloadedSkill | undefined {
  const content = safeReadFile(sourcePath)?.trim();
  if (content === undefined) return undefined;
  let declaredName: unknown;
  try {
    declaredName = parseFrontmatter(content).frontmatter.name;
  } catch (error) {
    // Malformed optional skills must not block the remaining preloads.
    if (error instanceof Error) return undefined;
    throw error;
  }
  const fallbackName = basename(sourcePath) === "SKILL.md" ? basename(dirname(sourcePath)) : basename(sourcePath, ".md");
  const skillName = typeof declaredName === "string" ? declaredName.trim() : fallbackName;
  if (skillName !== name) return undefined;
  return { name, content, sourcePath, baseDir: dirname(sourcePath) };
}
