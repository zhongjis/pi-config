import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HandoffConfig {
  lastSummaryModel?: string;
}

export const DEFAULT_HANDOFF_CONFIG: HandoffConfig = {};
export const HANDOFF_CONFIG_DIRECTORY = join(resolveHomeDirectory(), ".pi", "agent");
export const HANDOFF_CONFIG_PATH = join(HANDOFF_CONFIG_DIRECTORY, "handoff.json");

export function loadHandoffConfig(): HandoffConfig {
  try {
    const raw = JSON.parse(readFileSync(HANDOFF_CONFIG_PATH, "utf8"));
    return normalizeHandoffConfig(raw);
  } catch {
    return { ...DEFAULT_HANDOFF_CONFIG };
  }
}

export function saveHandoffConfig(config: HandoffConfig): HandoffConfig {
  const normalized = normalizeHandoffConfig(config);
  mkdirSync(HANDOFF_CONFIG_DIRECTORY, { recursive: true });
  writeFileSync(HANDOFF_CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export function updateHandoffConfig(patch: Partial<HandoffConfig>): HandoffConfig {
  return saveHandoffConfig({
    ...loadHandoffConfig(),
    ...patch,
  });
}

function resolveHomeDirectory(): string {
  const resolved = process.env.HOME?.trim() || homedir();
  if (!resolved) {
    throw new Error("Handoff config could not resolve the home directory");
  }
  return resolved.replace(/\/+$/u, "");
}

function normalizeHandoffConfig(value: unknown): HandoffConfig {
  const record = isPlainObject(value) ? value : {};
  return {
    lastSummaryModel:
      typeof record.lastSummaryModel === "string" && record.lastSummaryModel.trim().length > 0
        ? record.lastSummaryModel.trim()
        : undefined,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
