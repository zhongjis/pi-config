import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir as osHomedir } from "node:os";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";

export interface RecentSession {
  name: string;
  timeAgo: string;
}

export interface LoadedCounts {
  contextFiles: number;
  extensions: number;
  skills: number;
  promptTemplates: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared rendering utilities
// ═══════════════════════════════════════════════════════════════════════════

const PI_LOGO = [
  "██████████████",
  "   ██    ██   ",
  "   ██    ██   ",
  "   ██    ██   ",
  "   ██    ██   ",
];

function bold(theme: Theme, value: string): string {
  return theme.bold(value);
}

function dim(theme: Theme, value: string): string {
  return theme.fg("dim", value);
}

function muted(theme: Theme, value: string): string {
  return theme.fg("muted", value);
}

function primary(theme: Theme, value: string): string {
  return theme.fg("text", value);
}

function accent(theme: Theme, value: string): string {
  return theme.fg("accent", value);
}

function logo(theme: Theme, value: string): string {
  return accent(theme, value);
}

function checkmark(theme: Theme): string {
  return dim(theme, "✓");
}

function centerText(text: string, width: number): string {
  const visLen = visibleWidth(text);
  if (visLen > width) return truncateToWidth(text, width);
  if (visLen === width) return text;
  const leftPad = Math.floor((width - visLen) / 2);
  const rightPad = width - visLen - leftPad;
  return " ".repeat(leftPad) + text + " ".repeat(rightPad);
}

function fitToWidth(str: string, width: number): string {
  const visLen = visibleWidth(str);
  if (visLen > width) return truncateToWidth(str, width);
  return str + " ".repeat(width - visLen);
}

function truncateToWidth(str: string, width: number): string {
  if (width <= 0) return "";

  const ellipsis = "…";
  const maxWidth = Math.max(0, width - 1);
  let truncated = "";
  let currentWidth = 0;
  let inEscape = false;

  for (const char of str) {
    if (char === "\x1b") inEscape = true;
    if (inEscape) {
      truncated += char;
      if (char === "m") inEscape = false;
      continue;
    }

    const charWidth = visibleWidth(char);
    if (currentWidth + charWidth > maxWidth) {
      break;
    }

    truncated += char;
    currentWidth += charWidth;
  }

  if (visibleWidth(str) > width) return truncated + ellipsis;
  return truncated;
}

interface WelcomeData {
  modelName: string;
  providerName: string;
  recentSessions: RecentSession[];
  loadedCounts: LoadedCounts;
}

function buildCountLine(theme: Theme, count: number, label: string): string {
  return ` ${checkmark(theme)} ${primary(theme, String(count))} ${muted(theme, label)}`;
}

function buildSectionTitle(theme: Theme, label: string): string {
  return ` ${bold(theme, primary(theme, label))}`;
}

function buildLeftColumn(theme: Theme, data: WelcomeData, colWidth: number): string[] {
  const logoLines = PI_LOGO.map((line) => logo(theme, line));

  return [
    "",
    centerText(bold(theme, primary(theme, "Welcome back!")), colWidth),
    "",
    ...logoLines.map((line) => centerText(line, colWidth)),
    "",
    centerText(primary(theme, data.modelName), colWidth),
    centerText(dim(theme, data.providerName), colWidth),
  ];
}

function buildRightColumn(theme: Theme, data: WelcomeData, colWidth: number): string[] {
  const hChar = "─";
  const separator = ` ${dim(theme, hChar.repeat(colWidth - 2))}`;

  const sessionLines: string[] = [];
  if (data.recentSessions.length === 0) {
    sessionLines.push(` ${muted(theme, "No recent sessions")}`);
  } else {
    for (const session of data.recentSessions.slice(0, 3)) {
      sessionLines.push(
        ` ${dim(theme, "•")} ${primary(theme, session.name)}${dim(theme, ` (${session.timeAgo})`)}`,
      );
    }
  }

  const countLines: string[] = [];
  const { contextFiles, extensions, skills, promptTemplates } = data.loadedCounts;

  if (contextFiles > 0 || extensions > 0 || skills > 0 || promptTemplates > 0) {
    if (contextFiles > 0) {
      countLines.push(buildCountLine(theme, contextFiles, `context file${contextFiles !== 1 ? "s" : ""}`));
    }
    if (extensions > 0) {
      countLines.push(buildCountLine(theme, extensions, `extension${extensions !== 1 ? "s" : ""}`));
    }
    if (skills > 0) {
      countLines.push(buildCountLine(theme, skills, `skill${skills !== 1 ? "s" : ""}`));
    }
    if (promptTemplates > 0) {
      countLines.push(buildCountLine(theme, promptTemplates, `prompt template${promptTemplates !== 1 ? "s" : ""}`));
    }
  } else {
    countLines.push(` ${muted(theme, "No extensions loaded")}`);
  }

  return [
    buildSectionTitle(theme, "Tips"),
    ` ${dim(theme, "/")} ${muted(theme, "commands")}`,
    ` ${dim(theme, "!")} ${muted(theme, "bash")}`,
    ` ${dim(theme, "Shift+Tab")} ${muted(theme, "cycle thinking")}`,
    separator,
    buildSectionTitle(theme, "Loaded"),
    ...countLines,
    separator,
    buildSectionTitle(theme, "Recent sessions"),
    ...sessionLines,
    "",
  ];
}

function renderWelcomeBox(
  theme: Theme,
  data: WelcomeData,
  termWidth: number,
  bottomLine: string,
): string[] {
  const minLayoutWidth = 44;

  if (termWidth < minLayoutWidth) {
    return [];
  }

  const minWidth = 76;
  const maxWidth = 96;
  const boxWidth = Math.min(termWidth, Math.max(minWidth, Math.min(termWidth - 2, maxWidth)));
  const leftCol = 26;
  const rightCol = Math.max(1, boxWidth - leftCol - 3);

  const hChar = "─";
  const v = dim(theme, "│");
  const tl = dim(theme, "╭");
  const tr = dim(theme, "╮");
  const bl = dim(theme, "╰");
  const br = dim(theme, "╯");

  const leftLines = buildLeftColumn(theme, data, leftCol);
  const rightLines = buildRightColumn(theme, data, rightCol);

  const lines: string[] = [];

  const title = " pi agent ";
  const titlePrefix = dim(theme, hChar.repeat(3));
  const titleStyled = titlePrefix + primary(theme, title);
  const titleVisLen = 3 + visibleWidth(title);
  const afterTitle = boxWidth - 2 - titleVisLen;
  const afterTitleText = afterTitle > 0 ? dim(theme, hChar.repeat(afterTitle)) : "";
  lines.push(tl + titleStyled + afterTitleText + tr);

  const maxRows = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < maxRows; i++) {
    const left = fitToWidth(leftLines[i] ?? "", leftCol);
    const right = fitToWidth(rightLines[i] ?? "", rightCol);
    lines.push(v + left + v + right + v);
  }

  lines.push(bl + bottomLine + br);

  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// Welcome Components
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Welcome overlay component for pi agent.
 * Displays a branded splash screen with logo, tips, and loaded counts.
 */
export class WelcomeComponent implements Component {
  private data: WelcomeData;
  private countdown: number = 30;
  private theme: Theme;

  constructor(
    theme: Theme,
    modelName: string,
    providerName: string,
    recentSessions: RecentSession[] = [],
    loadedCounts: LoadedCounts = { contextFiles: 0, extensions: 0, skills: 0, promptTemplates: 0 },
  ) {
    this.theme = theme;
    this.data = { modelName, providerName, recentSessions, loadedCounts };
  }

  setCountdown(seconds: number): void {
    this.countdown = seconds;
  }

  invalidate(): void {}

  render(termWidth: number): string[] {
    const minLayoutWidth = 44;
    if (termWidth < minLayoutWidth) {
      return [];
    }

    const minWidth = 76;
    const maxWidth = 96;
    const boxWidth = Math.min(termWidth, Math.max(minWidth, Math.min(termWidth - 2, maxWidth)));

    const countdownText = ` Press any key to continue (${this.countdown}s) `;
    const countdownStyled = dim(this.theme, countdownText);
    const bottomContentWidth = boxWidth - 2;
    const countdownVisLen = visibleWidth(countdownText);
    const leftPad = Math.floor((bottomContentWidth - countdownVisLen) / 2);
    const rightPad = bottomContentWidth - countdownVisLen - leftPad;
    const hChar = "─";
    const bottomLine = dim(this.theme, hChar.repeat(Math.max(0, leftPad))) +
      countdownStyled +
      dim(this.theme, hChar.repeat(Math.max(0, rightPad)));

    return renderWelcomeBox(this.theme, this.data, termWidth, bottomLine);
  }
}

/**
 * Welcome header - same layout as overlay but persistent (no countdown).
 * Used when quietStartup: true.
 */
export class WelcomeHeader implements Component {
  private data: WelcomeData;
  private theme: Theme;

  constructor(
    theme: Theme,
    modelName: string,
    providerName: string,
    recentSessions: RecentSession[] = [],
    loadedCounts: LoadedCounts = { contextFiles: 0, extensions: 0, skills: 0, promptTemplates: 0 },
  ) {
    this.theme = theme;
    this.data = { modelName, providerName, recentSessions, loadedCounts };
  }

  invalidate(): void {}

  render(termWidth: number): string[] {
    const minLayoutWidth = 44;
    if (termWidth < minLayoutWidth) {
      return [];
    }

    const minWidth = 76;
    const maxWidth = 96;
    const boxWidth = Math.min(termWidth, Math.max(minWidth, Math.min(termWidth - 2, maxWidth)));
    const hChar = "─";

    const leftCol = 26;
    const rightCol = Math.max(1, boxWidth - leftCol - 3);
    const bottomLine = dim(this.theme, hChar.repeat(leftCol)) + dim(this.theme, "┴") + dim(this.theme, hChar.repeat(rightCol));

    const lines = renderWelcomeBox(this.theme, this.data, termWidth, bottomLine);
    if (lines.length > 0) {
      lines.push("");
    }
    return lines;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Discovery functions
// ═══════════════════════════════════════════════════════════════════════════

const loggedDiscoveryErrors = new Set<string>();

function logDiscoveryError(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${scope}:${message}`;
  if (loggedDiscoveryErrors.has(key)) {
    return;
  }

  loggedDiscoveryErrors.add(key);
  if (loggedDiscoveryErrors.size > 500) {
    loggedDiscoveryErrors.clear();
  }

  console.debug(`[powerline-welcome] ${scope}:`, error);
}

/**
 * Discover loaded counts by scanning filesystem.
 */
export function discoverLoadedCounts(): LoadedCounts {
  const homeDir = process.env.HOME || process.env.USERPROFILE || osHomedir();
  const cwd = process.cwd();
  
  let contextFiles = 0;
  let extensions = 0;
  let skills = 0;
  let promptTemplates = 0;

  const agentsMdPaths = [
    join(homeDir, ".pi", "agent", "AGENTS.md"),
    join(homeDir, ".claude", "AGENTS.md"),
    join(cwd, "AGENTS.md"),
    join(cwd, ".pi", "AGENTS.md"),
    join(cwd, ".claude", "AGENTS.md"),
  ];
  
  for (const path of agentsMdPaths) {
    if (existsSync(path)) contextFiles++;
  }

  const extensionDirs = [
    join(homeDir, ".pi", "agent", "extensions"),
    join(cwd, "extensions"),
    join(cwd, ".pi", "extensions"),
  ];

  const countedExtensions = new Set<string>();

  const settingsPaths = [
    join(homeDir, ".pi", "agent", "settings.json"),
    join(cwd, ".pi", "settings.json"),
  ];

  for (const settingsPath of settingsPaths) {
    if (!existsSync(settingsPath)) {
      continue;
    }

    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      let packages: unknown = null;
      if (typeof settings === "object" && settings !== null && !Array.isArray(settings)) {
        packages = (settings as { packages?: unknown }).packages;
      }

      if (Array.isArray(packages)) {
        for (const pkg of packages) {
          let source: unknown = null;
          let extensionsFilter: unknown = null;

          if (typeof pkg === "string") {
            source = pkg;
          } else if (typeof pkg === "object" && pkg !== null && !Array.isArray(pkg)) {
            source = (pkg as { source?: unknown }).source;
            extensionsFilter = (pkg as { extensions?: unknown }).extensions;
          }

          if (typeof source !== "string") {
            continue;
          }

          const normalizedSource = source.trim();
          if (!normalizedSource.startsWith("npm:")) {
            continue;
          }

          if (Array.isArray(extensionsFilter) && extensionsFilter.length === 0) {
            continue;
          }

          const body = normalizedSource.slice(4);
          const versionIndex = body.lastIndexOf("@");
          const name = versionIndex > 0 ? body.slice(0, versionIndex) : body;
          if (!name || countedExtensions.has(name)) {
            continue;
          }

          countedExtensions.add(name);
          extensions++;
        }
      }
    } catch (error) {
      logDiscoveryError(`Failed to read settings at ${settingsPath}`, error);
    }
  }

  for (const dir of extensionDirs) {
    if (existsSync(dir)) {
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const entryPath = join(dir, entry);

          try {
            const stats = statSync(entryPath);

            if (stats.isDirectory()) {
              if (
                existsSync(join(entryPath, "index.ts")) ||
                existsSync(join(entryPath, "index.js")) ||
                existsSync(join(entryPath, "package.json"))
              ) {
                if (!countedExtensions.has(entry)) {
                  countedExtensions.add(entry);
                  extensions++;
                }
              }
            } else if ((entry.endsWith(".ts") || entry.endsWith(".js")) && !entry.startsWith(".")) {
              const ext = entry.endsWith(".ts") ? ".ts" : ".js";
              const name = basename(entry, ext);
              if (!countedExtensions.has(name)) {
                countedExtensions.add(name);
                extensions++;
              }
            }
          } catch (error) {
            logDiscoveryError(`Failed to inspect extension entry ${entryPath}`, error);
          }
        }
      } catch (error) {
        logDiscoveryError(`Failed to scan extensions dir ${dir}`, error);
      }
    }
  }

  const skillDirs = [
    join(homeDir, ".pi", "agent", "skills"),
    join(cwd, ".pi", "skills"),
    join(cwd, "skills"),
  ];
  
  const countedSkills = new Set<string>();
  
  for (const dir of skillDirs) {
    if (existsSync(dir)) {
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const entryPath = join(dir, entry);
          try {
            if (statSync(entryPath).isDirectory()) {
              if (existsSync(join(entryPath, "SKILL.md"))) {
                if (!countedSkills.has(entry)) {
                  countedSkills.add(entry);
                  skills++;
                }
              }
            }
          } catch (error) {
            logDiscoveryError(`Failed to inspect skill entry ${entryPath}`, error);
          }
        }
      } catch (error) {
        logDiscoveryError(`Failed to scan skills dir ${dir}`, error);
      }
    }
  }

  const templateDirs = [
    join(homeDir, ".pi", "agent", "commands"),
    join(homeDir, ".claude", "commands"),
    join(cwd, ".pi", "commands"),
    join(cwd, ".claude", "commands"),
  ];
  
  const countedTemplates = new Set<string>();
  
  function countTemplatesInDir(dir: string) {
    if (!existsSync(dir)) return;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const entryPath = join(dir, entry);
        try {
          const stats = statSync(entryPath);
          if (stats.isDirectory()) {
            countTemplatesInDir(entryPath);
          } else if (entry.endsWith(".md")) {
            const name = basename(entry, ".md");
            if (!countedTemplates.has(name)) {
              countedTemplates.add(name);
              promptTemplates++;
            }
          }
        } catch (error) {
          logDiscoveryError(`Failed to inspect prompt template entry ${entryPath}`, error);
        }
      }
    } catch (error) {
      logDiscoveryError(`Failed to scan prompt template dir ${dir}`, error);
    }
  }
  
  for (const dir of templateDirs) {
    countTemplatesInDir(dir);
  }

  return { contextFiles, extensions, skills, promptTemplates };
}

/**
 * Get recent sessions from the sessions directory.
 */
export function getRecentSessions(maxCount: number = 3): RecentSession[] {
  const homeDir = process.env.HOME || process.env.USERPROFILE || osHomedir();
  
  const sessionsDirs = [
    join(homeDir, ".pi", "agent", "sessions"),
    join(homeDir, ".pi", "sessions"),
  ];
  
  const sessions: { name: string; mtime: number }[] = [];
  
  function scanDir(dir: string) {
    if (!existsSync(dir)) return;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const entryPath = join(dir, entry);
        try {
          const stats = statSync(entryPath);
          if (stats.isDirectory()) {
            scanDir(entryPath);
          } else if (entry.endsWith(".jsonl")) {
            const parentName = basename(dir);
            let projectName = parentName;
            if (parentName.startsWith("--")) {
              const parts = parentName.split("-").filter(p => p);
              projectName = parts[parts.length - 1] || parentName;
            }
            sessions.push({ name: projectName, mtime: stats.mtimeMs });
          }
        } catch (error) {
          logDiscoveryError(`Failed to inspect session entry ${entryPath}`, error);
        }
      }
    } catch (error) {
      logDiscoveryError(`Failed to scan sessions dir ${dir}`, error);
    }
  }
  
  for (const sessionsDir of sessionsDirs) {
    scanDir(sessionsDir);
  }
  
  if (sessions.length === 0) return [];
  
  sessions.sort((a, b) => b.mtime - a.mtime);
  
  const seen = new Set<string>();
  const uniqueSessions: typeof sessions = [];
  for (const s of sessions) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      uniqueSessions.push(s);
    }
  }

  const now = Date.now();
  return uniqueSessions.slice(0, maxCount).map(s => ({
    name: s.name.length > 20 ? s.name.slice(0, 17) + "…" : s.name,
    timeAgo: formatTimeAgo(now - s.mtime),
  }));
}

function formatTimeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}
