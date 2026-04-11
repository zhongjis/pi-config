/// <reference path="./clauderock-shims.d.ts" />
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { LegacyFallbackCacheEntry } from "./routing-state";

export function getCachePath(): string {
  return join(getAgentDir(), "clauderock-state.json");
}

function parseLegacyFallbackCache(raw: string): LegacyFallbackCacheEntry | null {
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && parsed.exhausted) {
    return parsed as LegacyFallbackCacheEntry;
  }

  return null;
}

export function readCache(): LegacyFallbackCacheEntry | null {
  try {
    return parseLegacyFallbackCache(readFileSync(getCachePath(), "utf-8"));
  } catch {
    return null;
  }
}

export function writeCache(reason: string): void {
  const data: LegacyFallbackCacheEntry = {
    exhausted: true,
    since: new Date().toISOString(),
    reason,
  };

  writeFileSync(getCachePath(), JSON.stringify(data, null, 2));
}

export function clearCache(): void {
  try {
    unlinkSync(getCachePath());
  } catch {
    // file may not exist — ignore
  }
}
