import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type ProfileThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ProfileConfig {
  model: string;
  thinking: ProfileThinkingLevel;
  label?: string;
}

const VALID_THINKING_LEVELS = new Set<ProfileThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

let activeProfileIndex: number | null = null;
let profilesCache: ProfileConfig[] = [];

function getSettingsPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "settings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isThinkingLevel(value: unknown): value is ProfileThinkingLevel {
  return typeof value === "string" && VALID_THINKING_LEVELS.has(value as ProfileThinkingLevel);
}

function readSettingsForLoad(): Record<string, unknown> {
  const settingsPath = getSettingsPath();

  try {
    if (!existsSync(settingsPath)) {
      return {};
    }

    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[powerline-footer] Ignoring non-object settings at ${settingsPath}`);
      return {};
    }

    return parsed;
  } catch (error) {
    console.debug(`[powerline-footer] Failed to load settings from ${settingsPath}:`, error);
    return {};
  }
}

function readSettingsForWrite(): Record<string, unknown> | null {
  const settingsPath = getSettingsPath();

  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[powerline-footer] Refusing to write modelProfiles: settings at ${settingsPath} is not an object`);
      return null;
    }

    return parsed;
  } catch (error) {
    console.debug(`[powerline-footer] Failed to parse settings while writing modelProfiles at ${settingsPath}:`, error);
    return null;
  }
}

function persistSettings(settings: Record<string, unknown>): boolean {
  const settingsPath = getSettingsPath();

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    return true;
  } catch (error) {
    console.debug(`[powerline-footer] Failed to persist modelProfiles to ${settingsPath}:`, error);
    return false;
  }
}

function normalizeProfile(value: unknown): ProfileConfig | null {
  if (!isRecord(value)) {
    return null;
  }

  const model = value.model;
  const thinking = value.thinking;
  if (typeof model !== "string" || !model.trim() || !isThinkingLevel(thinking)) {
    return null;
  }

  const normalizedModel = model.trim();
  if (!parseModelSpec(normalizedModel)) {
    return null;
  }

  const profile: ProfileConfig = {
    model: normalizedModel,
    thinking,
  };

  if (typeof value.label === "string" && value.label.trim()) {
    profile.label = value.label.trim();
  }

  return profile;
}

function clampActiveIndex(length: number): void {
  if (activeProfileIndex !== null && (activeProfileIndex < 0 || activeProfileIndex >= length)) {
    activeProfileIndex = null;
  }
}

export function reloadProfiles(): ProfileConfig[] {
  const settings = readSettingsForLoad();
  const stored = settings.modelProfiles;
  if (!Array.isArray(stored)) {
    profilesCache = [];
    activeProfileIndex = null;
    return profilesCache;
  }

  const nextProfiles: ProfileConfig[] = [];
  for (const entry of stored) {
    const profile = normalizeProfile(entry);
    if (profile) {
      nextProfiles.push(profile);
    }
  }

  profilesCache = nextProfiles;
  clampActiveIndex(profilesCache.length);
  return profilesCache;
}

export function getProfilesCache(): ProfileConfig[] {
  return profilesCache;
}

export function saveProfiles(profiles: ProfileConfig[]): boolean {
  const settings = readSettingsForWrite();
  if (!settings) {
    return false;
  }

  settings.modelProfiles = profiles;

  const persisted = persistSettings(settings);
  if (!persisted) {
    return false;
  }

  profilesCache = [...profiles];
  clampActiveIndex(profilesCache.length);
  return true;
}

export function getActiveProfileIndex(): number | null {
  return activeProfileIndex;
}

export function setActiveProfileIndex(index: number | null): void {
  activeProfileIndex = index;
}

export function findMatchingProfileIndex(
  profiles: ProfileConfig[],
  provider: string,
  modelId: string,
  thinkingLevel: string,
): number | null {
  for (let i = 0; i < profiles.length; i++) {
    const parsed = parseModelSpec(profiles[i].model);
    if (!parsed) {
      continue;
    }
    if (parsed.provider === provider && parsed.modelId === modelId && profiles[i].thinking === thinkingLevel) {
      return i;
    }
  }

  return null;
}

export function parseModelSpec(spec: string): { provider: string; modelId: string } | null {
  const normalized = spec.trim();
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) {
    return null;
  }

  const provider = normalized.slice(0, slashIndex).trim();
  const modelId = normalized.slice(slashIndex + 1).trim();
  if (!provider || !modelId) {
    return null;
  }

  return { provider, modelId };
}

export function getProfileDisplayName(profile: ProfileConfig, modelName?: string): string {
  if (profile.label) return profile.label;
  if (modelName) return modelName;
  return parseModelSpec(profile.model)?.modelId ?? profile.model;
}
