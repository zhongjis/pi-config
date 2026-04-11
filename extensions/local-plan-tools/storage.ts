declare function require(id: string): any;

const { getAgentDir } = require("@mariozechner/pi-coding-agent") as { getAgentDir: () => string };
const { mkdir, readFile, realpath, writeFile } = require("fs/promises") as {
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  readFile: (path: string, encoding: string) => Promise<string>;
  realpath: (path: string) => Promise<string>;
  writeFile: (path: string, data: string, encoding: string) => Promise<void>;
};
const { dirname, isAbsolute, relative, resolve } = require("path") as {
  dirname: (path: string) => string;
  isAbsolute: (path: string) => boolean;
  relative: (from: string, to: string) => string;
  resolve: (...parts: string[]) => string;
};

export interface SessionPlanContext {
  sessionManager: {
    getSessionId(): string;
  };
}

export interface LocalRootTarget {
  kind: "root";
  input: string;
  relativePath: "";
}

export interface LocalPathTarget {
  kind: "path";
  input: string;
  relativePath: string;
}

export type SessionLocalTarget = LocalRootTarget | LocalPathTarget;

const LOCAL_ROOT_SEGMENT = "local";
export const LOCAL_URI_PREFIX = "local://";
const PLAN_FILE_NAME = "PLAN.md";
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

function getSafeSessionId(ctx: SessionPlanContext): string {
  const rawSessionId = ctx.sessionManager.getSessionId().trim();
  if (!rawSessionId) {
    throw new Error("Rejected session plan path: session ID is empty.");
  }

  if (!SAFE_SESSION_ID_PATTERN.test(rawSessionId)) {
    throw new Error("Rejected session plan path: session ID contains unsupported characters.");
  }

  return rawSessionId;
}

function validateRelativeLocalPath(relativePath: string): string {
  if (relativePath.length === 0) {
    throw new Error("Rejected local:// path: relative path is empty.");
  }

  if (relativePath.includes("\0")) {
    throw new Error("Rejected local:// path: embedded NUL bytes are not allowed.");
  }

  if (relativePath.startsWith("/")) {
    throw new Error("Rejected local:// path: absolute paths are not allowed.");
  }

  return relativePath;
}

function resolveSessionLocalPath(ctx: SessionPlanContext, relativePath: string): string {
  const sessionRoot = getSessionLocalRoot(ctx);
  const targetPath = assertDescendant(sessionRoot, resolve(sessionRoot, validateRelativeLocalPath(relativePath)), "local path");

  if (targetPath === sessionRoot) {
    throw new Error("Rejected local:// path: target resolves to the session local root. Use local:// for root listing targets.");
  }

  return targetPath;
}

function isSlashOnlyPath(value: string): boolean {
  return value.length > 0 && /^\/+$/u.test(value);
}

async function getExistingAncestor(path: string): Promise<string | undefined> {
  let currentPath = path;

  while (true) {
    try {
      await realpath(currentPath);
      return currentPath;
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return undefined;
    }

    currentPath = parentPath;
  }
}

async function assertExistingPathWithin(basePath: string, targetPath: string, label: string): Promise<string> {
  const existingBasePath = await getExistingAncestor(basePath);
  const existingTargetPath = await getExistingAncestor(targetPath);
  if (!existingBasePath || !existingTargetPath) {
    return targetPath;
  }

  const realBasePath = await realpath(existingBasePath);
  const realTargetPath = await realpath(existingTargetPath);
  return assertDescendant(realBasePath, realTargetPath, label);
}

async function assertSessionLocalBoundary(ctx: SessionPlanContext): Promise<string> {
  const agentDirectory = getAgentDir();
  const localRoot = getLocalRoot();
  const sessionRoot = getSessionLocalRoot(ctx);

  await assertExistingPathWithin(agentDirectory, localRoot, "local storage root");
  await assertExistingPathWithin(localRoot, sessionRoot, "session local root");

  return sessionRoot;
}

export function isLocalPathTarget(target: string): boolean {
  return target.startsWith(LOCAL_URI_PREFIX);
}

export function isLocalRootTarget(target: string): boolean {
  if (!isLocalPathTarget(target)) {
    return false;
  }

  const remainder = target.slice(LOCAL_URI_PREFIX.length);
  return remainder === "" || isSlashOnlyPath(remainder);
}

export function isLocalListingTarget(target: string): boolean {
  return isLocalRootTarget(target);
}

export function parseSessionLocalTarget(target: string): SessionLocalTarget {
  if (!isLocalPathTarget(target)) {
    throw new Error(`Expected a ${LOCAL_URI_PREFIX} path.`);
  }

  const remainder = target.slice(LOCAL_URI_PREFIX.length);
  if (remainder === "" || isSlashOnlyPath(remainder)) {
    return { kind: "root", input: target, relativePath: "" };
  }

  return {
    kind: "path",
    input: target,
    relativePath: validateRelativeLocalPath(remainder),
  };
}

export function getSessionLocalRoot(ctx: SessionPlanContext): string {
  const localRoot = getLocalRoot();
  const sessionDirectory = resolve(localRoot, getSafeSessionId(ctx));
  return assertDescendant(localRoot, sessionDirectory, "session local root");
}

export function getSessionLocalPath(ctx: SessionPlanContext, relativePath: string): string {
  return resolveSessionLocalPath(ctx, relativePath);
}

export async function ensureSessionLocalRootDirectory(ctx: SessionPlanContext): Promise<string> {
  const sessionRoot = await assertSessionLocalBoundary(ctx);
  await mkdir(sessionRoot, { recursive: true });
  await assertSessionLocalBoundary(ctx);
  return sessionRoot;
}

export async function resolveSessionLocalRelativePath(ctx: SessionPlanContext, relativePath: string): Promise<string> {
  const sessionRoot = await assertSessionLocalBoundary(ctx);
  const targetPath = resolveSessionLocalPath(ctx, relativePath);
  await assertExistingPathWithin(sessionRoot, targetPath, "local path");
  return targetPath;
}

export async function resolveSessionLocalTarget(ctx: SessionPlanContext, target: string): Promise<string> {
  const parsedTarget = parseSessionLocalTarget(target);
  if (parsedTarget.kind === "root") {
    return assertSessionLocalBoundary(ctx);
  }

  return resolveSessionLocalRelativePath(ctx, parsedTarget.relativePath);
}

export async function readSessionLocalFile(ctx: SessionPlanContext, relativePath: string): Promise<string> {
  return readFile(await resolveSessionLocalRelativePath(ctx, relativePath), "utf8");
}

export async function writeSessionLocalFile(ctx: SessionPlanContext, relativePath: string, content: string): Promise<string> {
  const targetPath = await resolveSessionLocalRelativePath(ctx, relativePath);
  await mkdir(dirname(targetPath), { recursive: true });
  const verifiedTargetPath = await resolveSessionLocalRelativePath(ctx, relativePath);
  await writeFile(verifiedTargetPath, content, "utf8");
  return verifiedTargetPath;
}

export function getPlanDirectory(ctx: SessionPlanContext): string {
  return getSessionLocalRoot(ctx);
}

export function getPlanPath(ctx: SessionPlanContext): string {
  return getSessionLocalPath(ctx, PLAN_FILE_NAME);
}

export async function ensurePlanParentDirectory(ctx: SessionPlanContext): Promise<string> {
  return ensureSessionLocalRootDirectory(ctx);
}

export async function readPlanFile(ctx: SessionPlanContext): Promise<string> {
  return readSessionLocalFile(ctx, PLAN_FILE_NAME);
}

export async function writePlanFile(ctx: SessionPlanContext, content: string): Promise<string> {
  return writeSessionLocalFile(ctx, PLAN_FILE_NAME, content);
}
