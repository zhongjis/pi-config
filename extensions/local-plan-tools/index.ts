declare function require(id: string): any;

const { Type } = require("@sinclair/typebox") as {
  Type: {
    Integer(options?: Record<string, unknown>): unknown;
    Object(properties: Record<string, unknown>): unknown;
    Optional(schema: unknown): unknown;
  };
};
const { createHash } = require("crypto") as {
  createHash: (algorithm: string) => {
    update(input: string): { digest(encoding: string): string };
    digest(encoding: string): string;
  };
};
const { readdir, writeFile } = require("fs/promises") as {
  readdir: (
    path: string,
    options?: { withFileTypes?: boolean },
  ) => Promise<Array<{
    name: string;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>>;
  writeFile: (path: string, data: string, encoding: string) => Promise<void>;
};
const { resolve } = require("path") as {
  resolve: (...parts: string[]) => string;
};
const {
  createEditTool,
  createReadTool,
  createWriteTool,
} = require("@mariozechner/pi-coding-agent") as {
  createEditTool: (cwd: string) => ToolDefinition;
  createReadTool: (cwd: string) => ToolDefinition;
  createWriteTool: (cwd: string) => ToolDefinition;
};
import {
  ensureSessionLocalRootDirectory,
  getPlanPath,
  getSessionLocalPath,
  isLocalListingTarget,
  isLocalPathTarget,
  readPlanFile,
  resolveSessionLocalTarget,
  type SessionPlanContext,
  LOCAL_URI_PREFIX,
} from "./storage.js";

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  prepareArguments?: (input: unknown) => unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: SessionPlanContext,
  ) => Promise<ToolResult>;
  renderCall?: (...args: any[]) => unknown;
  renderResult?: (...args: any[]) => unknown;
}

interface ExtensionAPI {
  registerTool(definition: ToolDefinition): void;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details: Record<string, unknown> | undefined;
  isError?: boolean;
}

interface LocalResolution {
  localPath: string;
  resolvedPath: string;
  targetKind: "path" | "root";
  sessionRoot?: string;
  entryCount?: number;
}

const DEFAULT_READ_LIMIT = 2000;
const PLAN_FILE_NAME = "PLAN.md";
const PLAN_LOCAL_URI = `${LOCAL_URI_PREFIX}${PLAN_FILE_NAME}`;
const WRAPPER_MODE = "direct local:// resolution via built-in read/write/edit wrappers with session-local storage";
const LOCAL_ROOT_LISTING_FILE = ".local-root-listing.md";

function buildToolResult(text: string, details: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

function splitDisplayLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

function getLineAnchor(lineNumber: number, line: string): string {
  const digest = createHash("sha1").update(`${lineNumber}:${line}`).digest("base64");
  const lettersOnly = digest.replace(/[^A-Za-z]/g, "").toUpperCase();
  return (lettersOnly.slice(0, 2) || "XX").padEnd(2, "X");
}

function formatAnchoredRead(content: string, fileName: string, offset = 1, limit = DEFAULT_READ_LIMIT): string {
  const lines = splitDisplayLines(content);
  if (lines.length === 0) {
    return `File is empty: ${fileName}`;
  }

  if (offset > lines.length) {
    return `Start line ${offset} exceeds file length ${lines.length} for ${fileName}.`;
  }

  const startIndex = Math.max(0, offset - 1);
  const selectedLines = lines.slice(startIndex, startIndex + limit);
  return selectedLines
    .map((line, index) => {
      const lineNumber = startIndex + index + 1;
      return `${lineNumber}#${getLineAnchor(lineNumber, line)}:${line}`;
    })
    .join("\n");
}

function normalizePositiveInteger(value: unknown, fallbackValue: number, fieldName: string): number {
  if (value === undefined) {
    return fallbackValue;
  }

  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return value as number;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getRequestedPath(params: Record<string, unknown>): string | undefined {
  return typeof params.path === "string" ? params.path : undefined;
}

function buildLocalDetails(
  localPath: string,
  resolvedPath: string,
  extraDetails: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...extraDetails,
    path: resolvedPath,
    resolvedPath,
    backingPath: resolvedPath,
    localPath,
    wrapperMode: WRAPPER_MODE,
  };
}

function appendResolutionNote(
  content: ToolResult["content"],
  localPath: string,
  resolvedPath: string,
  targetKind: LocalResolution["targetKind"],
  sessionRoot?: string,
): ToolResult["content"] {
  const rootSuffix = targetKind === "root" && sessionRoot ? ` (session root: ${sessionRoot})` : "";
  const note = `Resolved ${localPath} -> ${resolvedPath}${rootSuffix}`;

  let noteAdded = false;
  const updatedContent = content.map((block) => {
    if (!noteAdded && block.type === "text") {
      noteAdded = true;
      return { ...block, text: `${block.text}\n${note}` };
    }

    return block;
  });

  return noteAdded ? updatedContent : [{ type: "text", text: note }, ...updatedContent];
}

function finalizeLocalResult(result: ToolResult, resolution: LocalResolution): ToolResult {
  const existingDetails = result.details && typeof result.details === "object" ? result.details : {};
  return {
    ...result,
    details: buildLocalDetails(resolution.localPath, resolution.resolvedPath, {
      ...existingDetails,
      targetKind: resolution.targetKind,
      ...(resolution.sessionRoot ? { sessionRoot: resolution.sessionRoot } : {}),
      ...(resolution.entryCount !== undefined ? { entryCount: resolution.entryCount } : {}),
    }),
    ...(result.isError
      ? {}
      : {
          content: appendResolutionNote(
            result.content,
            resolution.localPath,
            resolution.resolvedPath,
            resolution.targetKind,
            resolution.sessionRoot,
          ),
        }),
  };
}

function formatLocalErrorMessage(action: string, localPath: string, resolvedPath: string, error: unknown): string {
  const rawMessage = getErrorMessage(error);
  const rewrittenMessage = resolvedPath ? rawMessage.split(resolvedPath).join(localPath) : rawMessage;
  return `Error ${action} ${localPath}: ${rewrittenMessage}`;
}

async function readPlanOrError(
  ctx: SessionPlanContext,
): Promise<{ content?: string; planPath: string; error?: ToolResult }> {
  const planPath = getPlanPath(ctx);

  try {
    return { content: await readPlanFile(ctx), planPath };
  } catch (error) {
    const errorCode = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (errorCode === "ENOENT") {
      return {
        planPath,
        error: buildToolResult(`Error: ${PLAN_FILE_NAME} does not exist for this session yet.`, {
          ...buildLocalDetails(PLAN_LOCAL_URI, planPath),
        }, true),
      };
    }

    return {
      planPath,
      error: buildToolResult(`Error reading ${PLAN_FILE_NAME}: ${getErrorMessage(error)}`, {
        ...buildLocalDetails(PLAN_LOCAL_URI, planPath),
      }, true),
    };
  }
}

async function buildLocalRootListing(requestedPath: string, sessionRoot: string): Promise<{ text: string; entryCount: number }> {
  const lines: string[] = [
    "# local://",
    "",
    `Resolved backing path: \`${sessionRoot}\``,
  ];

  if (requestedPath !== LOCAL_URI_PREFIX) {
    lines.push(`Requested root alias: \`${requestedPath}\``);
  }

  const treeLines = await buildLocalRootTreeLines(sessionRoot, 0);
  lines.push("", "Contents:");

  if (treeLines.length === 0) {
    lines.push("- _(empty)_");
  } else {
    lines.push(...treeLines);
  }

  return {
    text: lines.join("\n"),
    entryCount: treeLines.length,
  };
}

async function buildLocalRootTreeLines(directoryPath: string, depth: number): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const sortedEntries = [...entries].sort((left, right) => {
    const leftDirectory = left.isDirectory();
    const rightDirectory = right.isDirectory();
    if (leftDirectory !== rightDirectory) {
      return leftDirectory ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });

  const indent = "  ".repeat(depth);
  const lines: string[] = [];

  for (const entry of sortedEntries) {
    const isDirectory = entry.isDirectory();
    const isSymbolicLink = entry.isSymbolicLink();
    const suffix = isDirectory ? "/" : isSymbolicLink ? "@" : "";
    lines.push(`${indent}- \`${entry.name}${suffix}\``);

    if (isDirectory) {
      lines.push(...(await buildLocalRootTreeLines(resolve(directoryPath, entry.name), depth + 1)));
    }
  }

  return lines;
}

async function buildLocalRootListingFile(
  ctx: SessionPlanContext,
  requestedPath: string,
): Promise<{ listingPath: string; sessionRoot: string; entryCount: number }> {
  const sessionRoot = await ensureSessionLocalRootDirectory(ctx);
  const listing = await buildLocalRootListing(requestedPath, sessionRoot);
  const listingPath = getSessionLocalPath(ctx, LOCAL_ROOT_LISTING_FILE);
  await writeFile(listingPath, listing.text, "utf8");

  return {
    listingPath,
    sessionRoot,
    entryCount: listing.entryCount,
  };
}

export default function localPlanTools(pi: ExtensionAPI): void {
  const cwd = require("process").cwd() as string;
  const builtInRead = createReadTool(cwd);
  const builtInWrite = createWriteTool(cwd);
  const builtInEdit = createEditTool(cwd);

  pi.registerTool({
    ...builtInRead,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const requestedPath = getRequestedPath(params);
      if (!requestedPath || !isLocalPathTarget(requestedPath)) {
        return builtInRead.execute(toolCallId, params, signal, onUpdate, ctx);
      }

      if (isLocalListingTarget(requestedPath)) {
        try {
          const { listingPath, sessionRoot, entryCount } = await buildLocalRootListingFile(ctx, requestedPath);
          const result = await builtInRead.execute(toolCallId, { ...params, path: listingPath }, signal, onUpdate, ctx);
          return finalizeLocalResult(result as ToolResult, {
            localPath: requestedPath,
            resolvedPath: listingPath,
            targetKind: "root",
            sessionRoot,
            entryCount,
          });
        } catch (error) {
          return buildToolResult(`Error reading ${requestedPath}: ${getErrorMessage(error)}`, {
            localPath: requestedPath,
            wrapperMode: WRAPPER_MODE,
          }, true);
        }
      }

      const resolvedPath = await resolveSessionLocalTarget(ctx, requestedPath);
      try {
        const result = await builtInRead.execute(toolCallId, { ...params, path: resolvedPath }, signal, onUpdate, ctx);
        return finalizeLocalResult(result as ToolResult, {
          localPath: requestedPath,
          resolvedPath,
          targetKind: "path",
        });
      } catch (error) {
        return buildToolResult(formatLocalErrorMessage("reading", requestedPath, resolvedPath, error), {
          ...buildLocalDetails(requestedPath, resolvedPath),
        }, true);
      }
    },
  });

  pi.registerTool({
    ...builtInWrite,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const requestedPath = getRequestedPath(params);
      if (!requestedPath || !isLocalPathTarget(requestedPath)) {
        return builtInWrite.execute(toolCallId, params, signal, onUpdate, ctx);
      }

      if (isLocalListingTarget(requestedPath)) {
        return buildToolResult(
          `Error: write does not support ${LOCAL_URI_PREFIX} root targets. Use read path="local://" to inspect the session-local root.`,
          {
            localPath: requestedPath,
            wrapperMode: WRAPPER_MODE,
          },
          true,
        );
      }

      const resolvedPath = await resolveSessionLocalTarget(ctx, requestedPath);
      try {
        const result = await builtInWrite.execute(toolCallId, { ...params, path: resolvedPath }, signal, onUpdate, ctx);
        return finalizeLocalResult(result as ToolResult, {
          localPath: requestedPath,
          resolvedPath,
          targetKind: "path",
        });
      } catch (error) {
        return buildToolResult(formatLocalErrorMessage("writing", requestedPath, resolvedPath, error), {
          ...buildLocalDetails(requestedPath, resolvedPath),
        }, true);
      }
    },
  });

  pi.registerTool({
    ...builtInEdit,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const requestedPath = getRequestedPath(params);
      if (!requestedPath || !isLocalPathTarget(requestedPath)) {
        return builtInEdit.execute(toolCallId, params, signal, onUpdate, ctx);
      }

      if (isLocalListingTarget(requestedPath)) {
        return buildToolResult(
          `Error: edit does not support ${LOCAL_URI_PREFIX} root targets. Use read path="local://" to inspect the session-local root.`,
          {
            localPath: requestedPath,
            wrapperMode: WRAPPER_MODE,
          },
          true,
        );
      }

      const resolvedPath = await resolveSessionLocalTarget(ctx, requestedPath);
      try {
        const result = await builtInEdit.execute(toolCallId, { ...params, path: resolvedPath }, signal, onUpdate, ctx);
        return finalizeLocalResult(result as ToolResult, {
          localPath: requestedPath,
          resolvedPath,
          targetKind: "path",
        });
      } catch (error) {
        return buildToolResult(formatLocalErrorMessage("editing", requestedPath, resolvedPath, error), {
          ...buildLocalDetails(requestedPath, resolvedPath),
        }, true);
      }
    },
  });

  pi.registerTool({
    name: "read_plan",
    label: "ReadPlan",
    description: "Read the session-scoped PLAN.md backing file from ~/.pi/agent/local/<sessionId>/PLAN.md.",
    parameters: Type.Object({
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line number to start reading from." })),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, description: `Maximum number of lines to return. Defaults to ${DEFAULT_READ_LIMIT}.` }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const offset = normalizePositiveInteger(params.offset, 1, "offset");
        const limit = normalizePositiveInteger(params.limit, DEFAULT_READ_LIMIT, "limit");
        const result = await readPlanOrError(ctx);
        if (result.error || result.content === undefined) {
          return result.error as ToolResult;
        }

        return buildToolResult(formatAnchoredRead(result.content, PLAN_FILE_NAME, offset, limit), {
          ...buildLocalDetails(PLAN_LOCAL_URI, result.planPath),
          offset,
          limit,
          compatibilityAlias: "read_plan",
        });
      } catch (error) {
        return buildToolResult(`Error reading ${PLAN_FILE_NAME}: ${getErrorMessage(error)}`, {
          localPath: PLAN_LOCAL_URI,
          wrapperMode: WRAPPER_MODE,
          compatibilityAlias: "read_plan",
        }, true);
      }
    },
  });
}
