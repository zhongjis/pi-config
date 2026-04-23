import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createReadTool,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "fs";
import { access as fsAccess } from "fs/promises";
import { constants } from "fs";

import { formatHashlineReadPreview } from "../git/github.com/RimuruW/pi-hashline-edit/src/read";
import { getFileSnapshot } from "../git/github.com/RimuruW/pi-hashline-edit/src/snapshot";
import { loadFileKindAndText } from "../git/github.com/RimuruW/pi-hashline-edit/src/file-kind";
import { resolveToCwd } from "../git/github.com/RimuruW/pi-hashline-edit/src/path-utils";
import { normalizeToLF, stripBom } from "../git/github.com/RimuruW/pi-hashline-edit/src/edit-diff";
import { throwIfAborted } from "../git/github.com/RimuruW/pi-hashline-edit/src/runtime";

const PROMPTS_DIR = `${process.env.HOME}/.pi/agent/git/github.com/RimuruW/pi-hashline-edit/prompts`;

const READ_DESC = readFileSync(`${PROMPTS_DIR}/read.md`, "utf-8")
  .replaceAll("{{DEFAULT_MAX_LINES}}", String(DEFAULT_MAX_LINES))
  .replaceAll("{{DEFAULT_MAX_BYTES}}", formatSize(DEFAULT_MAX_BYTES))
  .trim();

const READ_PROMPT_SNIPPET = readFileSync(
  `${PROMPTS_DIR}/read-snippet.md`,
  "utf-8",
).trim();

const READ_PROMPT_GUIDELINES = readFileSync(
  `${PROMPTS_DIR}/read-guidelines.md`,
  "utf-8",
)
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("- "))
  .map((line) => line.slice(2));

export default function readToolVisual(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read",
    label: "Read",
    description: READ_DESC,
    promptSnippet: READ_PROMPT_SNIPPET,
    promptGuidelines: READ_PROMPT_GUIDELINES,
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the file to read (relative or absolute)",
      }),
      offset: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Line number to start reading from (1-indexed)",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Maximum number of lines to read",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const rawPath = params.path;
      const absolutePath = resolveToCwd(rawPath, ctx.cwd);

      throwIfAborted(signal);
      try {
        await fsAccess(absolutePath, constants.R_OK);
      } catch (error: unknown) {
        const code = error instanceof Error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
        if (code === "ENOENT") {
          throw new Error(`File not found: ${rawPath}`);
        }
        if (code === "EACCES" || code === "EPERM") {
          throw new Error(`File is not readable: ${rawPath}`);
        }
        throw new Error(`Cannot access file: ${rawPath}`);
      }

      throwIfAborted(signal);
      const file = await loadFileKindAndText(absolutePath);
      if (file.kind === "directory") {
        throw new Error(`Path is a directory: ${rawPath}. Use ls to inspect directories.`);
      }

      if (file.kind === "binary") {
        throw new Error(`Path is a binary file: ${rawPath} (${file.description}). Hashline read only supports UTF-8 text files and supported images.`);
      }

      if (file.kind === "image") {
        const builtinRead = createReadTool(ctx.cwd);
        return builtinRead.execute(_toolCallId, params, signal, _onUpdate, ctx);
      }

      throwIfAborted(signal);
      const normalized = normalizeToLF(stripBom(file.text).text);
      const preview = formatHashlineReadPreview(normalized, {
        offset: params.offset,
        limit: params.limit,
      });
      const snapshot = await getFileSnapshot(absolutePath);

      return {
        content: [{ type: "text", text: preview.text }],
        details: {
          truncation: preview.truncation,
          snapshotId: snapshot.snapshotId,
          ...(preview.nextOffset !== undefined ? { nextOffset: preview.nextOffset } : {}),
          metrics: {
            truncated: !!preview.truncation,
            ...(preview.nextOffset !== undefined ? { next_offset: preview.nextOffset } : {}),
          },
        },
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("read "));
      text += theme.fg("accent", args.path);
      if (args.offset || args.limit) {
        const parts: string[] = [];
        if (args.offset) parts.push(`offset=${args.offset}`);
        if (args.limit) parts.push(`limit=${args.limit}`);
        text += theme.fg("dim", ` (${parts.join(", ")})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, _context) {
      if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);
      const content = result.content[0];
      if (content?.type === "image") return new Text(theme.fg("success", "✓ Image loaded"), 0, 0);
      if (content?.type !== "text") return new Text(theme.fg("error", "No content"), 0, 0);

      const lineCount = content.text.split("\n").length;
      let text = theme.fg("success", `✓ ${lineCount} lines`);

      // Show truncation warning from details
      const details = result.details as any;
      if (details?.truncation?.truncated) {
        text += theme.fg("warning", ` (truncated from ${details.truncation.totalLines})`);
      }

      if (expanded) {
        const lines = content.text.split("\n").slice(0, 20);
        for (const line of lines) {
          text += `\n${theme.fg("dim", line)}`;
        }
        if (lineCount > 20) {
          text += `\n${theme.fg("muted", `... (${lineCount - 20} more lines)`)}`;
        }
      } else {
        // Collapsed: first 5 lines preview
        const lines = content.text.split("\n").slice(0, 5);
        for (const line of lines) {
          text += `\n${theme.fg("dim", line)}`;
        }
        if (lineCount > 5) {
          text += `\n${theme.fg("muted", `... (${lineCount - 5} more lines)`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
