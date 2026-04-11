import type { CavemanLevel } from "./config.js";

declare const process: {
  getBuiltinModule?: (name: string) => {
    readFileSync: (path: string | URL, encoding: string) => string;
  } | undefined;
};

const fsModule = process.getBuiltinModule?.("fs");
if (!fsModule) {
  throw new Error("Caveman prompt loader requires Node.js fs builtin access");
}

const { readFileSync } = fsModule;

const PROMPT_SOURCE_URL = new URL("./upstream-caveman.SKILL.md", import.meta.url);
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
  text: string;
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
  return PROMPT_SOURCE_URL.pathname;
}

export function loadPromptSource(): CavemanPromptSourceDocument {
  if (promptSourceCache) {
    return promptSourceCache;
  }

  const raw = readPromptSource();
  const content = stripLeadingSyncNote(raw);
  const parsed = parsePromptSource(content);

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
  const fragments = normalizeRuntimeFragments(source);

  runtimePromptCache = {
    source,
    fragments,
    text: renderRuntimePrompt(fragments),
  };

  return runtimePromptCache;
}

function readPromptSource(): string {
  const source = readFileSync(PROMPT_SOURCE_URL, "utf-8").replace(/\r\n/g, "\n").trim();

  if (!source) {
    throw new Error(`Caveman prompt source is empty: ${getPromptSourcePath()}`);
  }

  return source;
}

function stripLeadingSyncNote(source: string): string {
  const trimmedStart = source.trimStart();

  if (!trimmedStart.startsWith("<!--")) {
    return source;
  }

  const commentEnd = trimmedStart.indexOf("-->");
  if (commentEnd === -1) {
    throw new Error(`Caveman prompt source has an unterminated sync note: ${getPromptSourcePath()}`);
  }

  return trimmedStart.slice(commentEnd + 3).trim();
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
    prelude: normalizePrelude(source.prelude),
    rules: source.sections.Rules,
    intensity: source.sections.Intensity,
    autoClarity: source.sections["Auto-Clarity"],
    boundaries: normalizeBoundaries(source.sections.Boundaries),
  };
}

function normalizePrelude(prelude: string): string {
  return cleanNormalizedText(
    prelude
      .replace(
        'Default: **full**. Switch: `/caveman lite|full|ultra`.',
        'Default: **full**.',
      )
      .replace(' Off only: "stop caveman" / "normal mode".', ""),
  );
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

function renderRuntimePrompt(fragments: CavemanRuntimePromptFragments): string {
  return [
    fragments.prelude,
    renderSection("Rules", fragments.rules),
    renderSection("Intensity", fragments.intensity),
    renderSection("Auto-Clarity", fragments.autoClarity),
    renderSection("Boundaries", fragments.boundaries),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderSection(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

export function buildInjectedPrompt(level: CavemanLevel): string {
  const { fragments } = loadRuntimePrompt();
  const levelInstruction = getLevelInstruction(fragments.intensity, level);

  return cleanNormalizedText(
    [
      firstParagraph(fragments.prelude),
      `Active level: ${level}. ${levelInstruction}`,
      `Rules: ${collapseInline(firstParagraph(fragments.rules))}`,
      `Auto-Clarity: ${collapseInline(firstParagraph(fragments.autoClarity))}`,
      `Boundaries: ${collapseInline(firstParagraph(fragments.boundaries))}`,
    ].join("\n"),
  );
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

function collapseInline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
