import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Mode } from "./types.js";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const modesRoot = resolve(sourceDir, "..", "..", "..", "modes");

export function getModeSkillPaths(mode: Mode): string[] {
	const skillsDir = getModeSkillsDir(mode);
	return isDirectory(skillsDir) ? [skillsDir] : [];
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function getModeSkillsDir(mode: Mode): string {
	return resolve(modesRoot, mode, "skills");
}
