declare function require(id: string): any;

const { access, mkdir, readdir, rm, stat, writeFile } = require("fs/promises") as {
  access: (path: string) => Promise<void>;
  mkdir: (path: string, options: { recursive?: boolean; mode?: number }) => Promise<void>;
  readdir: (
    path: string,
    options?: { withFileTypes?: boolean },
  ) => Promise<Array<{
    name: string;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>>;
  rm: (path: string, options: { force?: boolean }) => Promise<void>;
  stat: (path: string) => Promise<{ size: number; isDirectory(): boolean }>;
  writeFile: (path: string, data: string, encoding: string) => Promise<void>;
};
const { dirname, join } = require("path") as {
  dirname: (path: string) => string;
  join: (...parts: string[]) => string;
};
const { tmpdir } = require("os") as {
  tmpdir: () => string;
};
const { createHash } = require("crypto") as {
  createHash: (algorithm: string) => { update(data: string): { digest(encoding: "hex"): string } };
};

import {
  ensureSessionLocalRootDirectory,
  isLocalPathTarget,
  isLocalRootTarget,
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

interface BeforeAgentStartEvent {
  systemPromptOptions?: { sections?: Record<string, string> };
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
  targetKind: "path" | "directory";
  directoryPath?: string;
  entryCount?: number;
}

const WRAPPER_MODE = "tool_call/tool_result local:// path rewriting with session-local storage";
const SESSION_LOCAL_TOOL_NAMES = new Set(["read", "write", "edit"]);

const PROMPT_GUIDE = [
  "## Agent-tree-local storage (session-local)",
  "Read and write scratch/working files at `local://` paths with the `read`, `write`, and `edit` tools — no separate tool:",
  "- `write` to a `local://<rel/path>` path creates or overwrites a file; `read` and `edit` take the same `local://` paths.",
  "- Files resolve under one per-Agent-tree root shared by a parent session and its fresh agent descendants; unrelated sessions use separate roots.",
  "- `read` of a `local://` folder, including bare `local://`, lists its entries one level deep with their `local://` paths and its backing directory.",
  "- Only these three tools resolve `local://`; `bash` and MCP tools receive it as a literal string. Results echo `local://` paths, not the backing location, and `..` traversal is rejected.",
  "This is same-user convenience scoping, not an OS sandbox.",
].join("\n");

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
    ...(resolution.directoryPath ? { directoryPath: resolution.directoryPath } : {}),
    ...(resolution.entryCount !== undefined ? { entryCount: resolution.entryCount } : {}),
  });
}

/** Normalized `local://` URI of a folder, ending in exactly one `/`. */
function folderUri(requestedPath: string): string {
  return isLocalRootTarget(requestedPath) ? LOCAL_URI_PREFIX : requestedPath.replace(/\/*$/u, "/");
}

/** One-level listing of a backing folder, every entry with its `local://` path. */
async function buildLocalListing(requestedPath: string, directoryPath: string): Promise<{ text: string; entryCount: number }> {
  const uri = folderUri(requestedPath);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const sortedEntries = [...entries].sort((left, right) => {
    const leftDirectory = left.isDirectory();
    const rightDirectory = right.isDirectory();
    if (leftDirectory !== rightDirectory) {
      return leftDirectory ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });

  const lines: string[] = [
    `# ${uri} · ${sortedEntries.length} ${sortedEntries.length === 1 ? "entry" : "entries"}`,
    "",
    `Backing path: \`${directoryPath}\``,
    "",
  ];

  if (sortedEntries.length === 0) {
    lines.push("_(empty)_");
  }

  for (const entry of sortedEntries) {
    if (entry.isDirectory()) {
      lines.push(`- ${entry.name}/ · \`${uri}${entry.name}/\``);
    } else if (entry.isSymbolicLink()) {
      lines.push(`- ${entry.name}@ · \`${uri}${entry.name}\``);
    } else {
      const { size } = await stat(join(directoryPath, entry.name));
      lines.push(`- ${entry.name}  (${size} bytes) · \`${uri}${entry.name}\``);
    }
  }

  lines.push("", `Read an entry with \`${uri}<name>\`.`);

  return {
    text: lines.join("\n"),
    entryCount: sortedEntries.length,
  };
}

/** Listings live outside the Agent-tree root, one file per tool call, so concurrent reads never share one.
 *  Provider tool-call IDs can exceed filename limits, so the name is a hash of the ID. */
function listingFilePath(toolCallId: string): string {
  const name = createHash("sha256").update(toolCallId).digest("hex").slice(0, 32);
  return join(tmpdir(), `pi-session-local-${process.getuid?.() ?? 0}`, `${name}.md`);
}

async function isDirectoryPath(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export default function sessionLocalTools(pi: ExtensionAPI): void {
  const localResolutions = new Map<string, LocalResolution>();
  const listingFiles = new Map<string, string>();

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

    const resolvedPath = isLocalRootTarget(requestedPath)
      ? await ensureSessionLocalRootDirectory(ctx)
      : await resolveSessionLocalTarget(ctx, requestedPath);

    if (await isDirectoryPath(resolvedPath)) {
      if (event.toolName !== "read") {
        return {
          block: true,
          reason: `${event.toolName} does not support ${LOCAL_URI_PREFIX} folder targets. Use read path="${requestedPath}" to list the folder.`,
        };
      }

      const listing = await buildLocalListing(requestedPath, resolvedPath);
      const listingPath = listingFilePath(event.toolCallId);
      await mkdir(dirname(listingPath), { recursive: true, mode: 0o700 });
      await writeFile(listingPath, listing.text, "utf8");
      listingFiles.set(event.toolCallId, listingPath);
      event.input.path = listingPath;
      localResolutions.set(event.toolCallId, {
        localPath: requestedPath,
        resolvedPath: listingPath,
        targetKind: "directory",
        directoryPath: resolvedPath,
        entryCount: listing.entryCount,
      });
      return undefined;
    }

    if (event.toolName === "read") {
      let exists = true;
      try {
        await access(resolvedPath);
      } catch {
        exists = false;
      }
      if (!exists) {
        return {
          block: true,
          reason: `${requestedPath} was not found in this Agent tree's local storage. local:// files are shared by parent and descendant Agents in this tree; unrelated sessions use separate roots. Run read path="local://" to inspect this tree's local root and backing path.`,
        };
      }
    }

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
    const listingPath = listingFiles.get(event.toolCallId);
    if (listingPath) {
      listingFiles.delete(event.toolCallId);
      await rm(listingPath, { force: true });
    }
    return undefined;
  });

  // Teach the model the local:// path grammar (part of the cacheable system prompt).
  pi.on("before_agent_start", async (rawEvent) => {
    const event = rawEvent as BeforeAgentStartEvent | null;
    const sections = event?.systemPromptOptions?.sections;
    if (!sections) {
      return undefined;
    }
    sections.session_local = PROMPT_GUIDE;
    return undefined;
  });
}
