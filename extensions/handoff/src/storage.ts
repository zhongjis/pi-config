import { createHash } from "crypto";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, isAbsolute, relative, resolve } from "path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import {
  HANDOFF_PERSISTED_STATUSES,
  LOCAL_HANDOFF_AUTHORITY_URI,
  LOCAL_HANDOFF_BRIEFING_URI,
  LOCAL_PLAN_URI,
  type HandoffAuthorityRecord,
  type HandoffFreshnessCheck,
  type HandoffPersistedStatus,
  type HandoffReadiness,
  type HandoffResolvedState,
  type PlanAuthoritySnapshot,
} from "./types.js";
import {
  createMissingReadiness,
  createNotReadyReadiness,
  createReadyReadiness,
  createStaleReadiness,
} from "./protocol.js";

export interface HandoffStorageContext {
  sessionManager: {
    getSessionId(): string;
  };
}

export interface CreateHandoffAuthorityInput {
  handoffId: string;
  planHash: string;
  planTitle?: string;
  producerMode: string;
  targetMode: string;
  kickoffPrompt: string;
  createdAt?: string;
  status?: HandoffPersistedStatus;
  consumedAt?: string;
}

const LOCAL_ROOT_SEGMENT = "local";
export const PLAN_FILE_NAME = "PLAN.md";
export const HANDOFF_BRIEFING_FILE_NAME = "HANDOFF.md";
export const HANDOFF_AUTHORITY_FILE_NAME = "HANDOFF.json";

const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === "string" ? maybeCode : undefined;
}

function assertDescendant(basePath: string, targetPath: string, label: string): string {
  const rel = relative(basePath, targetPath);
  if (rel === "" || rel === ".") {
    return targetPath;
  }

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Rejected ${label}: resolved path escapes the session storage root.`);
  }

  return targetPath;
}

function getLocalRoot(): string {
  return resolve(getAgentDir(), LOCAL_ROOT_SEGMENT);
}

function getSafeSessionId(ctx: HandoffStorageContext): string {
  const rawSessionId = ctx.sessionManager.getSessionId().trim();
  if (!rawSessionId) {
    throw new Error("Rejected handoff path: session ID is empty.");
  }

  if (!SAFE_SESSION_ID_PATTERN.test(rawSessionId)) {
    throw new Error("Rejected handoff path: session ID contains unsupported characters.");
  }

  return rawSessionId;
}

function getSessionLocalRoot(ctx: HandoffStorageContext): string {
  const localRoot = getLocalRoot();
  const sessionDirectory = resolve(localRoot, getSafeSessionId(ctx));
  return assertDescendant(localRoot, sessionDirectory, "session local root");
}

function getSessionLocalPath(ctx: HandoffStorageContext, relativePath: string): string {
  const sessionRoot = getSessionLocalRoot(ctx);
  return assertDescendant(sessionRoot, resolve(sessionRoot, relativePath), "local path");
}

async function readOptionalUtf8(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

async function writeUtf8(path: string, content: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid HANDOFF.json: expected an object.");
  }

  return value as Record<string, unknown>;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid HANDOFF.json: ${key} must be a non-empty string.`);
  }

  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid HANDOFF.json: ${key} must be a non-empty string when present.`);
  }

  return value;
}

function readRequiredUri(record: Record<string, unknown>, key: string, expectedValue: string): string {
  const value = readRequiredString(record, key);
  if (value !== expectedValue) {
    throw new Error(`Invalid HANDOFF.json: ${key} must be ${expectedValue}.`);
  }

  return value;
}

function isKnownValue<const T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
  return typeof value === "string" && choices.includes(value as T[number]);
}

function parseHandoffAuthorityRecord(content: string): HandoffAuthorityRecord {
  const parsed = asRecord(JSON.parse(content) as unknown);
  const status = parsed.status;
  if (!isKnownValue(status, HANDOFF_PERSISTED_STATUSES)) {
    throw new Error(`Invalid HANDOFF.json: status must be one of ${HANDOFF_PERSISTED_STATUSES.join(", ")}.`);
  }

  return {
    handoffId: readRequiredString(parsed, "handoffId"),
    status,
    producerMode: readRequiredString(parsed, "producerMode"),
    targetMode: readRequiredString(parsed, "targetMode"),
    kickoffPrompt: readRequiredString(parsed, "kickoffPrompt"),
    createdAt: readRequiredString(parsed, "createdAt"),
    consumedAt: readOptionalString(parsed, "consumedAt"),
    planHash: readRequiredString(parsed, "planHash"),
    planTitle: readOptionalString(parsed, "planTitle"),
    planUri: readRequiredUri(parsed, "planUri", LOCAL_PLAN_URI) as typeof LOCAL_PLAN_URI,
    briefingUri: readRequiredUri(parsed, "briefingUri", LOCAL_HANDOFF_BRIEFING_URI) as typeof LOCAL_HANDOFF_BRIEFING_URI,
    authorityUri: readRequiredUri(parsed, "authorityUri", LOCAL_HANDOFF_AUTHORITY_URI) as typeof LOCAL_HANDOFF_AUTHORITY_URI,
  };
}

export function hashPlanContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function derivePlanTitle(content: string): string | undefined {
  const match = content.match(/^\s{0,3}#\s+(.+?)\s*$/mu);
  if (!match) {
    return undefined;
  }

  const title = match[1].replace(/\s+#+\s*$/u, "").trim();
  return title || undefined;
}

export function createHandoffAuthorityRecord(input: CreateHandoffAuthorityInput): HandoffAuthorityRecord {
  return {
    handoffId: input.handoffId,
    status: input.status ?? "pending",
    producerMode: input.producerMode,
    targetMode: input.targetMode,
    kickoffPrompt: input.kickoffPrompt,
    createdAt: input.createdAt ?? new Date().toISOString(),
    consumedAt: input.consumedAt,
    planHash: input.planHash,
    planTitle: input.planTitle,
    planUri: LOCAL_PLAN_URI,
    briefingUri: LOCAL_HANDOFF_BRIEFING_URI,
    authorityUri: LOCAL_HANDOFF_AUTHORITY_URI,
  };
}

export function getPlanPath(ctx: HandoffStorageContext): string {
  return getSessionLocalPath(ctx, PLAN_FILE_NAME);
}

export function getHandoffBriefingPath(ctx: HandoffStorageContext): string {
  return getSessionLocalPath(ctx, HANDOFF_BRIEFING_FILE_NAME);
}

export function getHandoffAuthorityPath(ctx: HandoffStorageContext): string {
  return getSessionLocalPath(ctx, HANDOFF_AUTHORITY_FILE_NAME);
}

export async function writePlanSnapshot(ctx: HandoffStorageContext, content: string): Promise<string> {
  await ensureHandoffParentDirectory(ctx);
  return writeUtf8(getPlanPath(ctx), content);
}

export async function ensureHandoffParentDirectory(ctx: HandoffStorageContext): Promise<string> {
  const sessionRoot = getSessionLocalRoot(ctx);
  await mkdir(sessionRoot, { recursive: true });
  return sessionRoot;
}

export async function readPlanSnapshot(ctx: HandoffStorageContext): Promise<PlanAuthoritySnapshot | undefined> {
  const path = getPlanPath(ctx);
  const content = await readOptionalUtf8(path);
  if (content === undefined) {
    return undefined;
  }

  return {
    path,
    uri: LOCAL_PLAN_URI,
    content,
    planHash: hashPlanContent(content),
    planTitle: derivePlanTitle(content),
  };
}

export async function readHandoffBriefing(ctx: HandoffStorageContext): Promise<string | undefined> {
  return readOptionalUtf8(getHandoffBriefingPath(ctx));
}

export async function writeHandoffBriefing(ctx: HandoffStorageContext, briefing: string): Promise<string> {
  await ensureHandoffParentDirectory(ctx);
  return writeUtf8(getHandoffBriefingPath(ctx), briefing);
}

export async function readHandoffAuthority(ctx: HandoffStorageContext): Promise<HandoffAuthorityRecord | undefined> {
  const content = await readOptionalUtf8(getHandoffAuthorityPath(ctx));
  if (content === undefined) {
    return undefined;
  }

  return parseHandoffAuthorityRecord(content);
}

export async function writeHandoffAuthority(
  ctx: HandoffStorageContext,
  authority: HandoffAuthorityRecord,
): Promise<string> {
  await ensureHandoffParentDirectory(ctx);
  return writeUtf8(getHandoffAuthorityPath(ctx), `${JSON.stringify(authority, null, 2)}\n`);
}

export function comparePlanFreshness(
  authority: Pick<HandoffAuthorityRecord, "planHash">,
  plan: Pick<PlanAuthoritySnapshot, "planHash">,
): HandoffFreshnessCheck {
  return {
    isStale: authority.planHash !== plan.planHash,
    storedPlanHash: authority.planHash,
    latestPlanHash: plan.planHash,
  };
}

export function getHandoffReadiness(
  authority: HandoffAuthorityRecord | undefined,
  plan: PlanAuthoritySnapshot | undefined,
  briefing: string | undefined,
): { readiness: HandoffReadiness; freshness?: HandoffFreshnessCheck } {
  if (!authority) {
    return {
      readiness: createMissingReadiness("handoff-authority", `${LOCAL_HANDOFF_AUTHORITY_URI} is missing.`),
    };
  }

  if (!plan) {
    return {
      readiness: createMissingReadiness("plan", `${LOCAL_PLAN_URI} is missing.`, authority),
    };
  }

  const freshness = comparePlanFreshness(authority, plan);
  if (freshness.isStale) {
    return {
      freshness,
      readiness: createStaleReadiness(authority, freshness.latestPlanHash),
    };
  }

  if (briefing === undefined) {
    return {
      freshness,
      readiness: createMissingReadiness(
        "handoff-briefing",
        `${LOCAL_HANDOFF_BRIEFING_URI} is missing.`,
        authority,
      ),
    };
  }

  if (authority.status !== "pending") {
    return {
      freshness,
      readiness: createNotReadyReadiness(`Handoff status is ${authority.status}.`, { authority }),
    };
  }

  return {
    freshness,
    readiness: createReadyReadiness(authority, freshness.latestPlanHash),
  };
}

export async function readHandoffState(ctx: HandoffStorageContext): Promise<HandoffResolvedState> {
  const [plan, authority, briefing] = await Promise.all([
    readPlanSnapshot(ctx),
    readHandoffAuthority(ctx),
    readHandoffBriefing(ctx),
  ]);
  const { readiness, freshness } = getHandoffReadiness(authority, plan, briefing);

  return {
    authority,
    briefing,
    plan,
    freshness,
    readiness,
  };
}

export async function markHandoffConsumed(
  ctx: HandoffStorageContext,
  options: { consumedAt?: string } = {},
): Promise<HandoffAuthorityRecord | undefined> {
  const authority = await readHandoffAuthority(ctx);
  if (!authority) {
    return undefined;
  }

  const nextAuthority: HandoffAuthorityRecord = {
    ...authority,
    status: "consumed",
    consumedAt: authority.consumedAt ?? options.consumedAt ?? new Date().toISOString(),
  };
  await writeHandoffAuthority(ctx, nextAuthority);
  return nextAuthority;
}

export async function clearHandoffArtifacts(ctx: HandoffStorageContext): Promise<void> {
  await Promise.all([
    rm(getHandoffBriefingPath(ctx), { force: true }),
    rm(getHandoffAuthorityPath(ctx), { force: true }),
  ]);
}
