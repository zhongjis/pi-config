import {
  DEFAULT_CAVEMAN_CONFIG,
  ensureCavemanConfig,
  isCavemanLevel,
  resolveCavemanEffectiveLevel,
  updateCavemanConfig,
  type CavemanConfig,
  type CavemanLevel,
} from "./config.js";

interface CavemanCustomEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

export interface CavemanSessionContextLike {
  sessionManager: {
    getBranch(): CavemanCustomEntry[];
  };
}

export interface CavemanEntryWriter {
  appendEntry(customType: string, data: unknown): void;
}

export interface CavemanRuntimeState {
  config: CavemanConfig;
  sessionLevel?: CavemanLevel;
}

const runtimeState: CavemanRuntimeState = {
  config: { ...DEFAULT_CAVEMAN_CONFIG },
  sessionLevel: undefined,
};

export function restoreCavemanState(ctx: CavemanSessionContextLike): CavemanRuntimeState {
  runtimeState.config = ensureCavemanConfig();
  runtimeState.sessionLevel = getLatestSessionLevel(ctx);
  return getCavemanState();
}

export function clearCavemanState(): void {
  runtimeState.config = { ...DEFAULT_CAVEMAN_CONFIG };
  runtimeState.sessionLevel = undefined;
}

export function getCavemanState(): CavemanRuntimeState {
  return {
    config: { ...runtimeState.config },
    sessionLevel: runtimeState.sessionLevel,
  };
}

export function getCavemanSessionLevel(): CavemanLevel | undefined {
  return runtimeState.sessionLevel;
}

export function getCavemanEffectiveLevel(): CavemanLevel | undefined {
  return resolveCavemanEffectiveLevel(
    runtimeState.sessionLevel ?? runtimeState.config.defaultLevel,
  );
}

export function getCavemanConfig(): CavemanConfig {
  return { ...runtimeState.config };
}

export function updateRuntimeCavemanConfig(patch: Partial<CavemanConfig>): CavemanConfig {
  runtimeState.config = updateCavemanConfig(patch);
  return getCavemanConfig();
}

export function setCavemanSessionLevel(
  pi: CavemanEntryWriter,
  level: CavemanLevel,
): { changed: boolean; level: CavemanLevel } {
  if (runtimeState.sessionLevel === level) {
    return { changed: false, level };
  }

  pi.appendEntry("caveman-level", { level });
  runtimeState.sessionLevel = level;
  return { changed: true, level };
}

function getLatestSessionLevel(ctx: CavemanSessionContextLike): CavemanLevel | undefined {
  let latestLevel: CavemanLevel | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== "caveman-level") {
      continue;
    }

    const level = readLevelFromEntry(entry.data);
    if (level) {
      latestLevel = level;
    }
  }

  return latestLevel;
}

function readLevelFromEntry(data: unknown): CavemanLevel | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }

  const level = (data as { level?: unknown }).level;
  return isCavemanLevel(level) ? level : undefined;
}
