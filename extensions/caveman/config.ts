declare const process: {
  env?: Record<string, string | undefined>;
  getBuiltinModule?: (name: string) => unknown;
};

type FsBuiltinModule = {
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, content: string) => void;
};

type OsBuiltinModule = {
  homedir: () => string;
};

const fsModule = process.getBuiltinModule?.("fs") as FsBuiltinModule | undefined;
const osModule = process.getBuiltinModule?.("os") as OsBuiltinModule | undefined;

if (!fsModule || !osModule) {
  throw new Error("Caveman config requires Node.js fs/os builtin access");
}

const { mkdirSync, readFileSync, writeFileSync } = fsModule;
const { homedir } = osModule;

export const CAVEMAN_LEVELS = ["lite", "full", "ultra"] as const;
export type CavemanLevel = (typeof CAVEMAN_LEVELS)[number];
export type CavemanConfigDefaultLevel = CavemanLevel | "off";
export type CavemanStatusVisibility = "active" | "hidden";

export interface CavemanConfig {
  defaultLevel: CavemanConfigDefaultLevel;
  statusVisibility: CavemanStatusVisibility;
}

export const DEFAULT_CAVEMAN_CONFIG: CavemanConfig = {
  defaultLevel: "off",
  statusVisibility: "active",
};

const CAVEMAN_CONFIG_DIRECTORY = `${resolveHomeDirectory()}/.pi/agent`;
export const CAVEMAN_CONFIG_PATH = `${CAVEMAN_CONFIG_DIRECTORY}/caveman.json`;

export function isCavemanLevel(value: unknown): value is CavemanLevel {
  return typeof value === "string" && CAVEMAN_LEVELS.includes(value as CavemanLevel);
}

export function isCavemanConfigDefaultLevel(value: unknown): value is CavemanConfigDefaultLevel {
  return value === "off" || isCavemanLevel(value);
}

export function resolveCavemanEffectiveLevel(
  value: CavemanConfigDefaultLevel | undefined,
): CavemanLevel | undefined {
  return isCavemanLevel(value) ? value : undefined;
}

export function isCavemanStatusVisibility(value: unknown): value is CavemanStatusVisibility {
  return value === "active" || value === "hidden";
}

export function loadCavemanConfig(): CavemanConfig {
  try {
    const raw = JSON.parse(readFileSync(CAVEMAN_CONFIG_PATH, "utf-8"));
    return normalizeCavemanConfig(raw);
  } catch {
    return { ...DEFAULT_CAVEMAN_CONFIG };
  }
}

export function ensureCavemanConfig(): CavemanConfig {
  let raw: unknown;
  let needsSave = false;

  try {
    raw = JSON.parse(readFileSync(CAVEMAN_CONFIG_PATH, "utf-8"));
  } catch {
    needsSave = true;
  }

  if (!isPlainObject(raw)) {
    needsSave = true;
  } else {
    if (!isCavemanConfigDefaultLevel(raw.defaultLevel)) {
      needsSave = true;
    }
    if (!isCavemanStatusVisibility(raw.statusVisibility)) {
      needsSave = true;
    }
  }

  const normalized = normalizeCavemanConfig(raw);
  if (needsSave) {
    saveCavemanConfig(normalized);
  }

  return normalized;
}

export function saveCavemanConfig(config: CavemanConfig): CavemanConfig {
  const normalized = normalizeCavemanConfig(config);
  mkdirSync(CAVEMAN_CONFIG_DIRECTORY, { recursive: true });
  writeFileSync(CAVEMAN_CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export function updateCavemanConfig(patch: Partial<CavemanConfig>): CavemanConfig {
  const nextConfig = {
    ...loadCavemanConfig(),
    ...patch,
  };

  return saveCavemanConfig(nextConfig);
}

function resolveHomeDirectory(): string {
  const configuredHome = process.env?.HOME?.trim();
  const resolvedHome = configuredHome || homedir();

  if (!resolvedHome) {
    throw new Error("Caveman config could not resolve the home directory");
  }

  return resolvedHome.replace(/\/+$/, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeCavemanConfig(value: unknown): CavemanConfig {
  const data = isPlainObject(value) ? value : {};

  return {
    defaultLevel: isCavemanConfigDefaultLevel(data.defaultLevel)
      ? data.defaultLevel
      : DEFAULT_CAVEMAN_CONFIG.defaultLevel,
    statusVisibility: isCavemanStatusVisibility(data.statusVisibility)
      ? data.statusVisibility
      : DEFAULT_CAVEMAN_CONFIG.statusVisibility,
  };
}
