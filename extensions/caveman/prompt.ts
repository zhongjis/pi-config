import type { CavemanLevel } from "./config.js";

declare const process: {
  env?: Record<string, string | undefined>;
  getBuiltinModule?: (name: string) => unknown;
};

type FsBuiltinModule = {
  readFileSync: (path: string, encoding: string) => string;
};

type OsBuiltinModule = {
  homedir: () => string;
};

const fsModule = process.getBuiltinModule?.("fs") as FsBuiltinModule | undefined;
const osModule = process.getBuiltinModule?.("os") as OsBuiltinModule | undefined;
if (!fsModule || !osModule) {
  throw new Error("Caveman prompt loader requires Node.js fs/os builtin access");
}

const { readFileSync } = fsModule;
const { homedir } = osModule;

const SKILLS_DIRECTORY = `${resolveHomeDirectory()}/.pi/agent/skills`;
const SKILL_BY_LEVEL: Record<CavemanLevel, string> = {
  full: "caveman",
  ultra: "ultracave",
  wenyan: "megacave",
};
const REQUIRED_SECTION_TITLES = ["Rules", "When to break the rules"] as const;
// Pi owns mode persistence, status, and `/caveman` aliases; the skill's text for them is host-specific.
const DROPPED_SECTION_TITLES = new Set(["Persistence"]);

const promptCache = new Map<CavemanLevel, string>();

export function getPromptSourcePath(level: CavemanLevel): string {
  return `${SKILLS_DIRECTORY}/${SKILL_BY_LEVEL[level]}/SKILL.md`;
}

export function buildInjectedPrompt(level: CavemanLevel): string {
  const cached = promptCache.get(level);
  if (cached) {
    return cached;
  }

  const path = getPromptSourcePath(level);
  const prompt = parsePromptSource(stripYamlFrontmatter(readPromptSource(path), path), path);
  promptCache.set(level, prompt);
  return prompt;
}

function readPromptSource(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error(`Caveman prompt source not found: ${path}`);
  }

  const source = raw.replace(/\r\n/g, "\n").trim();
  if (!source) {
    throw new Error(`Caveman prompt source is empty: ${path}`);
  }

  return source;
}

function stripYamlFrontmatter(source: string, path: string): string {
  if (!source.startsWith("---\n")) {
    return source;
  }

  const match = source.match(/^---\n[\s\S]*?\n---(?:\n|$)/u);
  if (!match) {
    throw new Error(`Caveman prompt source has unterminated YAML frontmatter: ${path}`);
  }

  return source.slice(match[0].length).trim();
}

function parsePromptSource(source: string, path: string): string {
  // Split before each `## ` heading; the first chunk is the prelude (title line removed).
  const [prelude = "", ...sections] = source.split(/^(?=## )/mu);
  const titles = sections.map((section) => section.match(/^## +(.+?)\s*$/mu)?.[1] ?? "");

  for (const title of REQUIRED_SECTION_TITLES) {
    if (!titles.includes(title)) {
      throw new Error(`Caveman prompt source missing required section "${title}": ${path}`);
    }
  }

  const kept = sections.filter((_, index) => !DROPPED_SECTION_TITLES.has(titles[index] ?? ""));
  return [prelude.replace(/^# .*\n?/u, ""), ...kept]
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .join("\n\n");
}

function resolveHomeDirectory(): string {
  const configuredHome = process.env?.HOME?.trim();
  const resolvedHome = configuredHome || homedir();

  if (!resolvedHome) {
    throw new Error("Caveman prompt loader could not resolve the home directory");
  }

  return resolvedHome.replace(/\/+$/, "");
}
