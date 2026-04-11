declare function require(id: string): any;

const { createEditTool, createReadTool, createWriteTool } = require("@mariozechner/pi-coding-agent") as {
  createEditTool: (cwd: string) => unknown;
  createReadTool: (cwd: string) => unknown;
  createWriteTool: (cwd: string) => unknown;
};
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

import {
  getPlanPath,
  readPlanFile,
  writePlanFile,
  type SessionPlanContext,
} from "./storage.js";

interface ExtensionAPI {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: ((update: unknown) => void) | undefined,
      ctx: SessionPlanContext,
    ) => Promise<ToolResult>;
  }): void;
}

interface ToolLike {
  execute?: unknown;
}

interface FactoryProbe {
  createReadTool: boolean;
  createWriteTool: boolean;
  createEditTool: boolean;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

const DEFAULT_READ_LIMIT = 2000;
const PLAN_FILE_NAME = "PLAN.md";
const BUILTIN_FACTORY_PROBE = probeBuiltinFactories();
const WRAPPER_PATH = BUILTIN_FACTORY_PROBE.createReadTool && BUILTIN_FACTORY_PROBE.createWriteTool && BUILTIN_FACTORY_PROBE.createEditTool
  ? "Factory exports are callable in the extension runtime; this extension intentionally uses dedicated fs-backed wrappers around the fixed session PLAN.md path instead of depending on generic built-in tool execute contracts."
  : "Factory exports could not be fully probed in the extension runtime; this extension uses dedicated fs-backed wrappers around the fixed session PLAN.md path.";

function isToolLike(value: unknown): value is ToolLike {
  return Boolean(value) && typeof value === "object" && typeof (value as ToolLike).execute === "function";
}

function probeFactory(factory: (cwd: string) => unknown): boolean {
  try {
    return isToolLike(factory("."));
  } catch {
    return false;
  }
}

function probeBuiltinFactories(): FactoryProbe {
  return {
    createReadTool: probeFactory(createReadTool),
    createWriteTool: probeFactory(createWriteTool),
    createEditTool: probeFactory(createEditTool),
  };
}

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

function formatAnchoredRead(content: string, offset = 1, limit = DEFAULT_READ_LIMIT): string {
  const lines = splitDisplayLines(content);
  if (lines.length === 0) {
    return `File is empty: ${PLAN_FILE_NAME}`;
  }

  if (offset > lines.length) {
    return `Start line ${offset} exceeds file length ${lines.length} for ${PLAN_FILE_NAME}.`;
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

function buildDiff(oldText: string, newText: string, startLine: number): string {
  const oldLines = splitDisplayLines(oldText);
  const newLines = splitDisplayLines(newText);
  const diffLines = [
    `--- ${PLAN_FILE_NAME}`,
    `+++ ${PLAN_FILE_NAME}`,
    `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];

  return diffLines.join("\n");
}

function buildUpdatedAnchors(updatedContent: string, startLine: number, newText: string): string {
  const updatedLines = splitDisplayLines(updatedContent);
  if (updatedLines.length === 0) {
    return "Updated anchors:\nFile is empty: PLAN.md";
  }

  const replacementLineCount = Math.max(1, countVisibleLines(newText));
  const anchorLine = Math.min(Math.max(1, startLine), updatedLines.length);
  return ["Updated anchors:", formatAnchoredRead(updatedContent, anchorLine, replacementLineCount)].join("\n");
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

async function readPlanOrError(ctx: SessionPlanContext): Promise<{ content?: string; planPath: string; error?: ToolResult }> {
  const planPath = getPlanPath(ctx);

  try {
    return { content: await readPlanFile(ctx), planPath };
  } catch (error) {
    const errorCode = getErrorCode(error);
    if (errorCode === "ENOENT") {
      return {
        planPath,
        error: buildToolResult(`Error: ${PLAN_FILE_NAME} does not exist for this session yet.`, {
          path: planPath,
          wrapperPath: WRAPPER_PATH,
          builtinFactoryProbe: BUILTIN_FACTORY_PROBE,
        }, true),
      };
    }

    return {
      planPath,
      error: buildToolResult(`Error reading ${PLAN_FILE_NAME}: ${getErrorMessage(error)}`, {
        path: planPath,
        wrapperPath: WRAPPER_PATH,
        builtinFactoryProbe: BUILTIN_FACTORY_PROBE,
      }, true),
    };
  }
}

export default function localPlanTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read_plan",
    label: "ReadPlan",
    description: "Read the session-scoped PLAN.md backing file from ~/.pi/agent/local/<sessionId>/PLAN.md.",
    parameters: Type.Object({
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line number to start reading from." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: `Maximum number of lines to return. Defaults to ${DEFAULT_READ_LIMIT}.` })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const offset = normalizePositiveInteger(params.offset, 1, "offset");
        const limit = normalizePositiveInteger(params.limit, DEFAULT_READ_LIMIT, "limit");
        const result = await readPlanOrError(ctx);
        if (result.error || result.content === undefined) {
          return result.error as ToolResult;
        }

        return buildToolResult(formatAnchoredRead(result.content, offset, limit), {
          path: result.planPath,
          offset,
          limit,
          wrapperPath: WRAPPER_PATH,
          builtinFactoryProbe: BUILTIN_FACTORY_PROBE,
        });
      } catch (error) {
        return buildToolResult(`Error reading ${PLAN_FILE_NAME}: ${getErrorMessage(error)}`, {
          wrapperPath: WRAPPER_PATH,
          builtinFactoryProbe: BUILTIN_FACTORY_PROBE,
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
        return buildToolResult(`Wrote ${PLAN_FILE_NAME} for the current session.`, {
          path: planPath,
          bytes: content.length,
          wrapperPath: WRAPPER_PATH,
          builtinFactoryProbe: BUILTIN_FACTORY_PROBE,
        });
      } catch (error) {
        return buildToolResult(`Error writing ${PLAN_FILE_NAME}: ${getErrorMessage(error)}`, {
          wrapperPath: WRAPPER_PATH,
          builtinFactoryProbe: BUILTIN_FACTORY_PROBE,
        }, true);
      }
    },
  });

  pi.registerTool({
    name: "edit_plan",
    label: "EditPlan",
    description: "Perform a single exact replacement inside the current session PLAN.md backing file.",
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
            wrapperPath: WRAPPER_PATH,
            builtinFactoryProbe: BUILTIN_FACTORY_PROBE,
          }, true);
        }

        if (oldText === newText) {
          return buildToolResult("Error: replacement is identical to existing text.", {
            wrapperPath: WRAPPER_PATH,
            builtinFactoryProbe: BUILTIN_FACTORY_PROBE,
          }, true);
        }

        const result = await readPlanOrError(ctx);
        if (result.error || result.content === undefined) {
          return result.error as ToolResult;
        }

        const match = countOccurrences(result.content, oldText);
        if (match.count === 0 || match.firstIndex === -1) {
          return buildToolResult("Error: oldText was not found in PLAN.md.", {
            path: result.planPath,
            wrapperPath: WRAPPER_PATH,
            builtinFactoryProbe: BUILTIN_FACTORY_PROBE,
          }, true);
        }

        if (match.count > 1) {
          return buildToolResult(`Error: oldText matched ${match.count} times in PLAN.md. Provide a more specific exact match.`, {
            path: result.planPath,
            matches: match.count,
            wrapperPath: WRAPPER_PATH,
            builtinFactoryProbe: BUILTIN_FACTORY_PROBE,
          }, true);
        }

        const startLine = getStartLine(result.content, match.firstIndex);
        const updatedContent = `${result.content.slice(0, match.firstIndex)}${newText}${result.content.slice(match.firstIndex + oldText.length)}`;
        await writePlanFile(ctx, updatedContent);

        const responseText = [
          `Applied exact replacement in ${PLAN_FILE_NAME}.`,
          buildDiff(oldText, newText, startLine),
          buildUpdatedAnchors(updatedContent, startLine, newText),
        ].join("\n\n");

        return buildToolResult(responseText, {
          path: result.planPath,
          startLine,
          wrapperPath: WRAPPER_PATH,
          builtinFactoryProbe: BUILTIN_FACTORY_PROBE,
        });
      } catch (error) {
        return buildToolResult(`Error editing ${PLAN_FILE_NAME}: ${getErrorMessage(error)}`, {
          wrapperPath: WRAPPER_PATH,
          builtinFactoryProbe: BUILTIN_FACTORY_PROBE,
        }, true);
      }
    },
  });
}
