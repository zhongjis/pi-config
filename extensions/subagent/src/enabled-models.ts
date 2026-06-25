/**
 * Reads `enabledModels` from pi's settings (global `<agentDir>/settings.json`
 * + project-local `<cwd>/.pi/settings.json`, project wins) and resolves
 * entries to concrete `provider/modelId` keys for scope validation.
 *
 * Project overrides global, mirroring pi's SettingsManager deep-merge and our
 * own loadSettings precedence (src/settings.ts). Only exact `provider/modelId`
 * patterns are matched (case-insensitive); globs, bare IDs, and `:thinking`
 * suffixes are silently dropped (pi's scoped-models picker writes exact keys).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelEntry } from "./model-resolver.js";

/** Minimal registry shape — only what resolveEnabledModels calls. */
export interface ModelRegistryRef {
  getAll(): unknown[];
  getAvailable?(): unknown[];
}

/** Paths to pi's settings.json files: [project, global] (project takes precedence). */
function settingsPaths(cwd: string): [project: string, global: string] {
  return [join(cwd, ".pi", "settings.json"), join(getAgentDir(), "settings.json")];
}

/** Read `enabledModels` from a single settings.json file. Undefined when missing or absent. */
function readField(path: string): string[] | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(raw?.enabledModels)) return raw.enabledModels as string[];
  } catch {
    /* corrupt file — silent */
  }
  return undefined;
}

/** Read enabledModels from pi's settings — project-local overrides global. */
export function readEnabledModels(cwd: string): string[] | undefined {
  const [project, global] = settingsPaths(cwd);
  return readField(project) ?? readField(global);
}

// Module-level cache — invalidated when either settings.json changes or patterns differ.
let cachedAllowed: Set<string> | undefined;
let cachedHash = "";
let cachedPatternsKey = "";

function hashOf(path: string): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}-${s.size}`;
  } catch {
    return "missing";
  }
}

export function resolveEnabledModels(
  patterns: string[] | undefined,
  registry: ModelRegistryRef,
  cwd: string = process.cwd(),
): Set<string> | undefined {
  const patternsKey = JSON.stringify(patterns);
  const [project, global] = settingsPaths(cwd);
  const fileHash = `${hashOf(project)};${hashOf(global)}`;

  if (fileHash === cachedHash && patternsKey === cachedPatternsKey) {
    return cachedAllowed;
  }

  if (!patterns || patterns.length === 0) {
    cachedHash = fileHash;
    cachedPatternsKey = patternsKey;
    cachedAllowed = undefined;
    return undefined;
  }

  const available = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const allowed = new Set<string>();

  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    resolveExact(trimmed, available, allowed);
  }

  const result = allowed.size > 0 ? allowed : undefined;
  cachedHash = fileHash;
  cachedPatternsKey = patternsKey;
  cachedAllowed = result;
  return result;
}

/** Canonical lowercase `provider/id` key for the allowed set. */
function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`.toLowerCase();
}

/** True when `model` is in the allowed set. */
export function isModelInScope(
  model: { provider: string; id: string },
  allowed: Set<string>,
): boolean {
  return allowed.has(modelKey(model));
}

/** Resolve exact `provider/modelId` pattern against available models. */
function resolveExact(pattern: string, available: ModelEntry[], allowed: Set<string>): void {
  const slashIdx = pattern.indexOf("/");
  if (slashIdx === -1) return; // bare modelId not supported
  const provider = pattern.slice(0, slashIdx).toLowerCase();
  const modelId = pattern.slice(slashIdx + 1).toLowerCase();
  const exact = available.find(
    (m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId,
  );
  if (exact) allowed.add(modelKey(exact));
}

export type ScopeDecision =
  | { action: "allow" }
  | { action: "block"; message: string }
  | { action: "warn"; message: string };

/**
 * Pure scope decision. `allowed === undefined` (no scope configured) is a no-op.
 * Caller-supplied model out of scope → block; frontmatter/inherited → warn
 * (frontmatter is authoritative — never hard-error those).
 */
export function decideModelScope(opts: {
  model: { provider: string; id: string } | undefined;
  modelFromParams: boolean;
  allowed: Set<string> | undefined;
}): ScopeDecision {
  const { model, modelFromParams, allowed } = opts;
  if (!model || !allowed || allowed.size === 0) return { action: "allow" };
  if (isModelInScope(model, allowed)) return { action: "allow" };
  const list = [...allowed].map((m) => `  ${m}`).join("\n");
  const message = `Model not in scope: "${model.provider}/${model.id}".\n\nAllowed models:\n${list}`;
  return modelFromParams ? { action: "block", message } : { action: "warn", message };
}
