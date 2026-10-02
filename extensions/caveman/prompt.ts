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

const GLOBAL_PROMPT_SOURCE_PATH = `${resolveHomeDirectory()}/.pi/agent/skills/caveman/SKILL.md`;
const REQUIRED_SECTION_TITLES = ["Rules", "Intensity", "Auto-Clarity", "Boundaries"] as const;

type RequiredSectionTitle = (typeof REQUIRED_SECTION_TITLES)[number];

interface CavemanPromptSections {
  Rules: string;
  Intensity: string;
  "Auto-Clarity": string;
  Boundaries: string;
}

export interface CavemanPromptSourceDocument {
  raw: string;
  prelude: string;
  sections: CavemanPromptSections;
}

export interface CavemanRuntimePromptFragments {
  prelude: string;
  rules: string;
  intensity: string;
  autoClarity: string;
  boundaries: string;
}

export interface CavemanRuntimePrompt {
  source: CavemanPromptSourceDocument;
  fragments: CavemanRuntimePromptFragments;
}

interface ParsedHeading {
  title: string;
  start: number;
  bodyStart: number;
  end: number;
}

let promptSourceCache: CavemanPromptSourceDocument | undefined;
let runtimePromptCache: CavemanRuntimePrompt | undefined;

export function getPromptSourcePath(): string {
  return GLOBAL_PROMPT_SOURCE_PATH;
}

export function loadPromptSource(): CavemanPromptSourceDocument {
  if (promptSourceCache) {
    return promptSourceCache;
  }

  const raw = readPromptSource();
  const withoutFrontmatter = stripYamlFrontmatter(raw);
  const parsed = parsePromptSource(withoutFrontmatter);

  promptSourceCache = {
    raw,
    prelude: parsed.prelude,
    sections: parsed.sections,
  };

  return promptSourceCache;
}

export function loadRuntimePrompt(): CavemanRuntimePrompt {
  if (runtimePromptCache) {
    return runtimePromptCache;
  }

  const source = loadPromptSource();
  runtimePromptCache = {
    source,
    fragments: normalizeRuntimeFragments(source),
  };

  return runtimePromptCache;
}

function readPromptSource(): string {
  let raw: string;
  try {
    raw = readFileSync(GLOBAL_PROMPT_SOURCE_PATH, "utf-8");
  } catch {
    throw new Error(`Caveman prompt source not found: ${getPromptSourcePath()}`);
  }

  const source = raw.replace(/\r\n/g, "\n").trim();

  if (!source) {
    throw new Error(`Caveman prompt source is empty: ${getPromptSourcePath()}`);
  }

  return source;
}

function stripYamlFrontmatter(source: string): string {
  const trimmedStart = source.trimStart();
  if (!trimmedStart.startsWith("---\n")) {
    return source;
  }

  const match = trimmedStart.match(/^---\n[\s\S]*?\n---(?:\n|$)/u);
  if (!match) {
    throw new Error(`Caveman prompt source has unterminated YAML frontmatter: ${getPromptSourcePath()}`);
  }

  return trimmedStart.slice(match[0].length).trim();
}

function parsePromptSource(source: string): Omit<CavemanPromptSourceDocument, "raw"> {
  const headings = findHeadings(source);
  const rulesHeading = headings.find((heading) => heading.title === "Rules");

  if (!rulesHeading) {
    throw new Error(`Caveman prompt source missing required section "Rules": ${getPromptSourcePath()}`);
  }

  const sections = {} as CavemanPromptSections;
  for (const title of REQUIRED_SECTION_TITLES) {
    sections[title] = extractRequiredSection(source, headings, title);
  }

  return {
    prelude: source.slice(0, rulesHeading.start).trim(),
    sections,
  };
}

function findHeadings(source: string): ParsedHeading[] {
  const headingPattern = /^##\s+(.+?)\s*$/gm;
  const matches = Array.from(source.matchAll(headingPattern));

  return matches.map((match, index) => {
    const title = match[1]?.trim();
    const start = match.index;

    if (!title || start === undefined) {
      throw new Error(`Failed to parse caveman prompt headings: ${getPromptSourcePath()}`);
    }

    const nextStart = matches[index + 1]?.index ?? source.length;

    return {
      title,
      start,
      bodyStart: start + match[0].length,
      end: nextStart,
    };
  });
}

function extractRequiredSection(source: string, headings: ParsedHeading[], title: RequiredSectionTitle): string {
  const heading = headings.find((entry) => entry.title === title);

  if (!heading) {
    throw new Error(`Caveman prompt source missing required section "${title}": ${getPromptSourcePath()}`);
  }

  const body = source.slice(heading.bodyStart, heading.end).trim();

  if (!body) {
    throw new Error(`Caveman prompt source section "${title}" is empty: ${getPromptSourcePath()}`);
  }

  return body;
}

function normalizeRuntimeFragments(source: CavemanPromptSourceDocument): CavemanRuntimePromptFragments {
  return {
    prelude: cleanNormalizedText(source.prelude),
    rules: source.sections.Rules,
    intensity: source.sections.Intensity,
    autoClarity: source.sections["Auto-Clarity"],
    boundaries: normalizeBoundaries(source.sections.Boundaries),
  };
}

function normalizeBoundaries(boundaries: string): string {
  return cleanNormalizedText(
    boundaries.replace(' "stop caveman" or "normal mode": revert.', ""),
  );
}

function cleanNormalizedText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildInjectedPrompt(level: CavemanLevel): string {
  const { fragments } = loadRuntimePrompt();
  const levelInstruction = getLevelInstruction(fragments.intensity, level);
  const examples = getLevelExamples(fragments.intensity, level);
  const lines = [
    firstParagraph(fragments.prelude),
    `Active level: ${level}. ${levelInstruction}`,
    "Active level overrides Rules where they conflict.",
    `Rules: ${collapseInline(fragments.rules)}`,
  ];

  if (examples.length > 0) {
    lines.push(`Examples (${level}): ${examples.join(" ")}`);
  }

  lines.push(
    `Auto-Clarity: ${collapseInline(beforeExampleBlock(fragments.autoClarity))}`,
    `Boundaries: ${collapseInline(fragments.boundaries)}`,
  );

  return cleanNormalizedText(lines.join("\n"));
}

function getLevelInstruction(
  intensitySection: string,
  level: CavemanLevel,
): string {
  const levels = parseIntensityLevels(intensitySection);
  const instruction = levels[level];

  if (!instruction) {
    throw new Error(`Caveman intensity section missing level "${level}": ${getPromptSourcePath()}`);
  }

  return instruction;
}

function getLevelExamples(intensitySection: string, level: CavemanLevel): string[] {
  const examples: string[] = [];

  for (const line of intensitySection.split("\n")) {
    const match = line.match(/^- (lite|full|ultra):\s+(.+)$/i);
    if (!match || match[1]?.toLowerCase() !== level) {
      continue;
    }

    const example = collapseInline(match[2] ?? "");
    if (example) {
      examples.push(example);
    }
  }

  return examples;
}

function parseIntensityLevels(
  intensitySection: string,
): Partial<Record<CavemanLevel, string>> {
  const levels: Partial<Record<CavemanLevel, string>> = {};

  for (const line of intensitySection.split("\n")) {
    const match = line.match(/^\|\s*\*\*(lite|full|ultra)\*\*\s*\|\s*(.+?)\s*\|\s*$/i);
    if (!match) {
      continue;
    }

    const [, level, description] = match;
    levels[level.toLowerCase() as CavemanLevel] = collapseInline(description);
  }

  return levels;
}

function firstParagraph(text: string): string {
  return text.split(/\n\s*\n/u)[0]?.trim() ?? "";
}

export function beforeExampleBlock(text: string): string {
  const match = text.match(/(?:^|\n)\s*Example\b/u);
  if (!match || match.index === undefined) {
    return text.trim();
  }

  return text.slice(0, match.index).trim();
}

function resolveHomeDirectory(): string {
  const configuredHome = process.env?.HOME?.trim();
  const resolvedHome = configuredHome || homedir();

  if (!resolvedHome) {
    throw new Error("Caveman prompt loader could not resolve the home directory");
  }

  return resolvedHome.replace(/\/+$/, "");
}

function collapseInline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
