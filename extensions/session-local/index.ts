declare function require(id: string): any;

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
  getSessionLocalPath,
  isLocalListingTarget,
  isLocalPathTarget,
  resolveSessionLocalTarget,
  type SessionLocalContext,
  LOCAL_URI_PREFIX,
} from "./storage.js";

interface ToolCallEvent {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface ToolExecutionEndEvent {
  toolCallId: string;
}

interface ToolResultTextBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}

interface ToolResultOtherBlock {
  type: string;
  [key: string]: unknown;
}

type ToolResultBlock = ToolResultTextBlock | ToolResultOtherBlock;

interface ToolResultEvent {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: ToolResultBlock[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

interface ToolResultPatch {
  content?: ToolResultBlock[];
  details?: Record<string, unknown>;
}

interface ExtensionAPI {
  on(
    event: string,
    handler: (event: unknown, ctx: SessionLocalContext) => unknown | Promise<unknown>,
  ): void;
}

interface LocalResolution {
  localPath: string;
  resolvedPath: string;
  targetKind: "path" | "root";
  sessionRoot?: string;
  entryCount?: number;
}

const WRAPPER_MODE = "tool_call/tool_result local:// path rewriting with session-local storage";
const LOCAL_ROOT_LISTING_FILE = ".local-root-listing.md";
const SESSION_LOCAL_TOOL_NAMES = new Set(["read", "write", "edit"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRequestedPath(input: Record<string, unknown>): string | undefined {
  const value = input.path;
  return typeof value === "string" ? value : undefined;
}

function buildLocalDetails(
  localPath: string,
  resolvedPath: string,
  extraDetails: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...extraDetails,
    path: localPath,
    resolvedPath,
    backingPath: resolvedPath,
    localPath,
    wrapperMode: WRAPPER_MODE,
  };
}

function rewriteResolutionText(text: string, resolution: LocalResolution): string {
  return text.split(resolution.resolvedPath).join(resolution.localPath);
}

function rewriteResultContent(
  content: ToolResultBlock[],
  resolution: LocalResolution,
): ToolResultBlock[] {
  return content.map((block) => {
    if (block.type !== "text" || typeof block.text !== "string") {
      return block;
    }

    return {
      ...block,
      text: rewriteResolutionText(block.text, resolution),
    };
  });
}

function rewriteResultDetails(
  details: Record<string, unknown> | undefined,
  resolution: LocalResolution,
): Record<string, unknown> {
  const existingDetails = isRecord(details) ? details : {};
  return buildLocalDetails(resolution.localPath, resolution.resolvedPath, {
    ...existingDetails,
    targetKind: resolution.targetKind,
    ...(resolution.sessionRoot ? { sessionRoot: resolution.sessionRoot } : {}),
    ...(resolution.entryCount !== undefined ? { entryCount: resolution.entryCount } : {}),
  });
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
    if (entry.name === LOCAL_ROOT_LISTING_FILE) {
      continue;
    }

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
  ctx: SessionLocalContext,
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

export default function sessionLocalTools(pi: ExtensionAPI): void {
  const localResolutions = new Map<string, LocalResolution>();

  pi.on("tool_call", async (rawEvent, ctx) => {
    const event = rawEvent as ToolCallEvent | null;
    if (!event || typeof event.toolCallId !== "string") {
      return undefined;
    }
    if (!SESSION_LOCAL_TOOL_NAMES.has(event.toolName)) {
      return undefined;
    }
    if (!isRecord(event.input)) {
      return undefined;
    }

    const requestedPath = getRequestedPath(event.input);
    if (!requestedPath || !isLocalPathTarget(requestedPath)) {
      return undefined;
    }

    if (isLocalListingTarget(requestedPath)) {
      if (event.toolName !== "read") {
        return {
          block: true,
          reason: `${event.toolName} does not support ${LOCAL_URI_PREFIX} root targets. Use read path="local://" to inspect the session-local root.`,
        };
      }

      const { listingPath, sessionRoot, entryCount } = await buildLocalRootListingFile(ctx, requestedPath);
      event.input.path = listingPath;
      localResolutions.set(event.toolCallId, {
        localPath: requestedPath,
        resolvedPath: listingPath,
        targetKind: "root",
        sessionRoot,
        entryCount,
      });
      return undefined;
    }

    const resolvedPath = await resolveSessionLocalTarget(ctx, requestedPath);
    event.input.path = resolvedPath;
    localResolutions.set(event.toolCallId, {
      localPath: requestedPath,
      resolvedPath,
      targetKind: "path",
    });
    return undefined;
  });

  pi.on("tool_result", async (rawEvent) => {
    const event = rawEvent as ToolResultEvent | null;
    if (!event || typeof event.toolCallId !== "string") {
      return undefined;
    }

    const resolution = localResolutions.get(event.toolCallId);
    if (!resolution) {
      return undefined;
    }

    localResolutions.delete(event.toolCallId);
    return {
      content: rewriteResultContent(event.content, resolution),
      details: rewriteResultDetails(event.details, resolution),
    } satisfies ToolResultPatch;
  });

  pi.on("tool_execution_end", async (rawEvent) => {
    const event = rawEvent as ToolExecutionEndEvent | null;
    if (!event || typeof event.toolCallId !== "string") {
      return undefined;
    }

    localResolutions.delete(event.toolCallId);
    return undefined;
  });
}
