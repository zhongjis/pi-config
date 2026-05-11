import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ContextPruneConfig, PruneOn, SummarizerThinking } from "./types.js";
import { DEFAULT_CONFIG, PRUNE_ON_MODES, SUMMARIZER_THINKING_LEVELS } from "./types.js";

/**
 * Unified settings file for the context-management extension.
 * Shape:
 *   {
 *     "core":   { "auto": true },
 *     "pruner": { "enabled": true, "pruneOn": "agentic-auto", ... }
 *   }
 */
export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "context-management-settings.json");

/** Core (ACM) settings — independent of the pruner addon. */
export interface AcmConfig {
  /**
   * If true, the first interactive user input of each session is rewritten
   * from `<text>` to `/acm <text>`, so agentic context management activates
   * automatically without the user typing `/acm`.
   * No-op once `/acm` has already run in the session.
   */
  auto: boolean;
}

export const DEFAULT_ACM_CONFIG: AcmConfig = {
  auto: false,
};

interface UnifiedFile {
  core?: Partial<AcmConfig>;
  pruner?: Partial<ContextPruneConfig>;
}

function isPruneOn(value: unknown): value is PruneOn {
  return typeof value === "string" && PRUNE_ON_MODES.some((mode) => mode.value === value);
}

function isSummarizerThinking(value: unknown): value is SummarizerThinking {
  return typeof value === "string" && SUMMARIZER_THINKING_LEVELS.some((level) => level.value === value);
}

async function readUnified(): Promise<UnifiedFile> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object" ? parsed : {}) as UnifiedFile;
  } catch {
    return {};
  }
}

async function writeUnified(unified: UnifiedFile): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(unified, null, 2));
}

/** Load pruner slice (with defaults + validation). */
export async function loadConfig(): Promise<ContextPruneConfig> {
  const unified = await readUnified();
  const existing = unified.pruner ?? {};
  const merged = { ...DEFAULT_CONFIG, ...existing };
  return {
    ...merged,
    pruneOn: isPruneOn(merged.pruneOn) ? merged.pruneOn : DEFAULT_CONFIG.pruneOn,
    summarizerThinking: isSummarizerThinking(merged.summarizerThinking)
      ? merged.summarizerThinking
      : DEFAULT_CONFIG.summarizerThinking,
  };
}

/** Save pruner slice. Preserves the core slice. */
export async function saveConfig(config: ContextPruneConfig): Promise<void> {
  const unified = await readUnified();
  unified.pruner = config;
  await writeUnified(unified);
}

/** Load core (ACM) slice. */
export async function loadAcmConfig(): Promise<AcmConfig> {
  const unified = await readUnified();
  const existing = unified.core ?? {};
  return {
    ...DEFAULT_ACM_CONFIG,
    ...existing,
    auto: existing?.auto === true,
  };
}
