declare function require(id: string): any;

const { Type } = require("@sinclair/typebox") as {
  Type: {
    Integer(options?: Record<string, unknown>): unknown;
    Object(properties: Record<string, unknown>): unknown;
    Optional(schema: unknown): unknown;
    String(options?: Record<string, unknown>): unknown;
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

import {
  ensureSessionLocalRootDirectory,
  getPlanPath,
  getSessionLocalPath,
  isLocalListingTarget,
  isLocalPathTarget,
  readPlanFile,
  resolveSessionLocalTarget,
  writePlanFile,
  type SessionPlanContext,
  LOCAL_URI_PREFIX,
} from "./storage.js";

interface ExtensionAPI {
  registerTool(definition: {
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
  }): void;
  on(eventName: string, handler: (event: any, ctx: SessionPlanContext) => Promise<unknown> | unknown): void;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details: Record<string, unknown> | undefined;
  isError?: boolean;
}

interface PendingLocalResolution {
  localPath: string;
  resolvedPath: string;
  targetKind: "path" | "root";
  sessionRoot?: string;
  entryCount?: number;
}

const DEFAULT_READ_LIMIT = 2000;
const PLAN_FILE_NAME = "PLAN.md";
const PLAN_LOCAL_URI = `${LOCAL_URI_PREFIX}${PLAN_FILE_NAME}`;
const WRAPPER_MODE = "hook-based local:// resolution for built-in read/write/edit with session-local storage";
const LOCAL_ROOT_LISTING_FILE = ".local-root-listing.md";
const LOCAL_TOOL_NAMES = new Set(["read", "write", "edit"]);

const pendingLocalResolutions = new Map<string, PendingLocalResolution>();

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

function countOccurrences(content: string, searchText: string): { count: number; firstIndex: number } {
  let count = 0;
  let firstIndex = -1;
  let cursor = 0;

  while (cursor <= content.length) {
    const nextIndex = content.indexOf(searchText, cursor);
    if (nextIndex === -1) {
      break;
    }

    if (firstIndex === -1) {
      firstIndex = nextIndex;
    }

    count += 1;
    cursor = nextIndex + 1;
  }

  return { count, firstIndex };
}

function getStartLine(content: string, index: number): number {
  if (index <= 0) {
    return 1;
  }

  let lineNumber = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content[cursor] === "\n") {
      lineNumber += 1;
    }
  }

  return lineNumber;
}

function countVisibleLines(content: string): number {
  return splitDisplayLines(content).length;
}

function buildDiff(oldText: string, newText: string, startLine: number, fileName: string): string {
  const oldLines = splitDisplayLines(oldText);
  const newLines = splitDisplayLines(newText);
  const diffLines = [
    `--- ${fileName}`,
    `+++ ${fileName}`,
    `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];

  return diffLines.join("\n");
}

function buildUpdatedAnchors(updatedContent: string, startLine: number, newText: string, fileName: string): string {
  const updatedLines = splitDisplayLines(updatedContent);
  if (updatedLines.length === 0) {
    return `Updated anchors:\nFile is empty: ${fileName}`;
  }

  const replacementLineCount = Math.max(1, countVisibleLines(newText));
  const anchorLine = Math.min(Math.max(1, startLine), updatedLines.length);
  return ["Updated anchors:", formatAnchoredRead(updatedContent, fileName, anchorLine, replacementLineCount)].join("\n");
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

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === "string" ? maybeCode : undefined;
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
  targetKind: PendingLocalResolution["targetKind"],
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

function rememberLocalResolution(toolCallId: unknown, resolution: PendingLocalResolution): void {
  if (typeof toolCallId !== "string" || toolCallId.length === 0) {
    return;
  }

  pendingLocalResolutions.set(toolCallId, resolution);
}

function takeLocalResolution(toolCallId: unknown): PendingLocalResolution | undefined {
  if (typeof toolCallId !== "string" || toolCallId.length === 0) {
    return undefined;
  }

  const resolution = pendingLocalResolutions.get(toolCallId);
  pendingLocalResolutions.delete(toolCallId);
  return resolution;
}

async function readPlanOrError(
  ctx: SessionPlanContext,
): Promise<{ content?: string; planPath: string; error?: ToolResult }> {
  const planPath = getPlanPath(ctx);

  try {
    return { content: await readPlanFile(ctx), planPath };
  } catch (error) {
    const errorCode = getErrorCode(error);
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
  pi.on("tool_call", async (event, ctx) => {
    if (!LOCAL_TOOL_NAMES.has(event.toolName)) {
      return undefined;
    }

    const input = event.input as Record<string, unknown> | undefined;
    if (!input) {
      return undefined;
    }

    const requestedPath = getRequestedPath(input);
    if (!requestedPath || !isLocalPathTarget(requestedPath)) {
      return undefined;
    }

    if (isLocalListingTarget(requestedPath)) {
      if (event.toolName !== "read") {
        return {
          block: true,
          reason: `Error: ${event.toolName} does not support ${LOCAL_URI_PREFIX} root targets. Use read path=\"local://\" to inspect the session-local root.`,
        };
      }

      const { listingPath, sessionRoot, entryCount } = await buildLocalRootListingFile(ctx, requestedPath);
      input.path = listingPath;
      rememberLocalResolution(event.toolCallId, {
        localPath: requestedPath,
        resolvedPath: listingPath,
        targetKind: "root",
        sessionRoot,
        entryCount,
      });
      return undefined;
    }

    const resolvedPath = await resolveSessionLocalTarget(ctx, requestedPath);
    input.path = resolvedPath;
    rememberLocalResolution(event.toolCallId, {
      localPath: requestedPath,
      resolvedPath,
      targetKind: "path",
    });

    return undefined;
  });

  pi.on("tool_result", async (event) => {
    if (!LOCAL_TOOL_NAMES.has(event.toolName)) {
      return undefined;
    }

    const resolution = takeLocalResolution(event.toolCallId);
    if (!resolution) {
      return undefined;
    }

    const existingDetails = event.details && typeof event.details === "object" ? event.details : {};
    const mergedDetails = buildLocalDetails(resolution.localPath, resolution.resolvedPath, {
      ...existingDetails,
      targetKind: resolution.targetKind,
      ...(resolution.sessionRoot ? { sessionRoot: resolution.sessionRoot } : {}),
      ...(resolution.entryCount !== undefined ? { entryCount: resolution.entryCount } : {}),
    });

    return {
      details: mergedDetails,
      ...(event.isError
        ? {}
        : {
            content: appendResolutionNote(
              event.content,
              resolution.localPath,
              resolution.resolvedPath,
              resolution.targetKind,
              resolution.sessionRoot,
            ),
          }),
    };
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

  pi.registerTool({
    name: "write_plan",
    label: "WritePlan",
    description: "Replace the entire session-scoped PLAN.md backing file for the current session.",
    parameters: Type.Object({
      content: Type.String({ description: "Full markdown content for the session PLAN.md backing file." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const content = typeof params.content === "string" ? params.content : "";
        const planPath = await writePlanFile(ctx, content);
        return buildToolResult(
          `Wrote ${PLAN_FILE_NAME} for the current session.\nResolved local backing path: ${planPath}`,
          {
            ...buildLocalDetails(PLAN_LOCAL_URI, planPath),
            bytes: content.length,
            compatibilityAlias: "write_plan",
          },
        );
      } catch (error) {
        return buildToolResult(`Error writing ${PLAN_FILE_NAME}: ${getErrorMessage(error)}`, {
          localPath: PLAN_LOCAL_URI,
          wrapperMode: WRAPPER_MODE,
          compatibilityAlias: "write_plan",
        }, true);
      }
    },
  });

  pi.registerTool({
    name: "edit_plan",
    label: "EditPlan",
    description: "Perform a single exact replacement inside the current session-scoped PLAN.md backing file.",
    parameters: Type.Object({
      oldText: Type.String({ description: "Exact existing text to replace. Must match exactly once." }),
      newText: Type.String({ description: "Replacement text." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const oldText = typeof params.oldText === "string" ? params.oldText : "";
        const newText = typeof params.newText === "string" ? params.newText : "";

        if (!oldText) {
          return buildToolResult("Error: oldText must be non-empty.", {
            localPath: PLAN_LOCAL_URI,
            wrapperMode: WRAPPER_MODE,
            compatibilityAlias: "edit_plan",
          }, true);
        }

        if (oldText === newText) {
          return buildToolResult("Error: replacement is identical to existing text.", {
            localPath: PLAN_LOCAL_URI,
            wrapperMode: WRAPPER_MODE,
            compatibilityAlias: "edit_plan",
          }, true);
        }

        const result = await readPlanOrError(ctx);
        if (result.error || result.content === undefined) {
          return result.error as ToolResult;
        }

        const match = countOccurrences(result.content, oldText);
        if (match.count === 0 || match.firstIndex === -1) {
          return buildToolResult(`Error: oldText was not found in ${PLAN_FILE_NAME}.`, {
            ...buildLocalDetails(PLAN_LOCAL_URI, result.planPath),
            compatibilityAlias: "edit_plan",
          }, true);
        }

        if (match.count > 1) {
          return buildToolResult(
            `Error: oldText matched ${match.count} times in ${PLAN_FILE_NAME}. Provide a more specific exact match.`,
            {
              ...buildLocalDetails(PLAN_LOCAL_URI, result.planPath),
              matches: match.count,
              compatibilityAlias: "edit_plan",
            },
            true,
          );
        }

        const startLine = getStartLine(result.content, match.firstIndex);
        const updatedContent = `${result.content.slice(0, match.firstIndex)}${newText}${result.content.slice(
          match.firstIndex + oldText.length,
        )}`;
        await writePlanFile(ctx, updatedContent);

        const responseText = [
          `Applied exact replacement in ${PLAN_FILE_NAME}.`,
          `Resolved local backing path: ${result.planPath}`,
          buildDiff(oldText, newText, startLine, PLAN_FILE_NAME),
          buildUpdatedAnchors(updatedContent, startLine, newText, PLAN_FILE_NAME),
        ].join("\n\n");

        return buildToolResult(responseText, {
          ...buildLocalDetails(PLAN_LOCAL_URI, result.planPath),
          startLine,
          compatibilityAlias: "edit_plan",
        });
      } catch (error) {
        return buildToolResult(`Error editing ${PLAN_FILE_NAME}: ${getErrorMessage(error)}`, {
          localPath: PLAN_LOCAL_URI,
          wrapperMode: WRAPPER_MODE,
          compatibilityAlias: "edit_plan",
        }, true);
      }
    },
  });
}
