declare function require(id: string): any;

const { getAgentDir } = require("@mariozechner/pi-coding-agent") as { getAgentDir: () => string };
const { mkdir, readFile, writeFile } = require("fs/promises") as {
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  readFile: (path: string, encoding: string) => Promise<string>;
  writeFile: (path: string, data: string, encoding: string) => Promise<void>;
};
const { isAbsolute, relative, resolve } = require("path") as {
  isAbsolute: (path: string) => boolean;
  relative: (from: string, to: string) => string;
  resolve: (...parts: string[]) => string;
};

export interface SessionPlanContext {
  sessionManager: {
    getSessionId(): string;
  };
}

const LOCAL_ROOT_SEGMENT = "local";
const PLAN_FILE_NAME = "PLAN.md";
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

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

export function getPlanDirectory(ctx: SessionPlanContext): string {
  const localRoot = getLocalRoot();
  const sessionDirectory = resolve(localRoot, getSafeSessionId(ctx));
  return assertDescendant(localRoot, sessionDirectory, "session directory");
}

export function getPlanPath(ctx: SessionPlanContext): string {
  const sessionDirectory = getPlanDirectory(ctx);
  const planPath = resolve(sessionDirectory, PLAN_FILE_NAME);
  return assertDescendant(sessionDirectory, planPath, PLAN_FILE_NAME);
}

export async function ensurePlanParentDirectory(ctx: SessionPlanContext): Promise<string> {
  const directory = getPlanDirectory(ctx);
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function readPlanFile(ctx: SessionPlanContext): Promise<string> {
  return readFile(getPlanPath(ctx), "utf8");
}

export async function writePlanFile(ctx: SessionPlanContext, content: string): Promise<string> {
  await ensurePlanParentDirectory(ctx);
  const planPath = getPlanPath(ctx);
  await writeFile(planPath, content, "utf8");
  return planPath;
}
