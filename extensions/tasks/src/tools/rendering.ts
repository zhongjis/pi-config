import { type AgentToolResult, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import {
  extractToolText,
  firstMeaningfulLine,
  renderToolCall,
  renderToolExpanded,
  renderToolSummary,
} from "../../../lib/tool-output.js";

type TaskOp = "create" | "update" | "list" | "get";
type ToolTheme = Pick<Theme, "fg" | "bold">;
type TaskRenderOptions = Pick<ToolRenderResultOptions, "expanded" | "isPartial">;
type TaskRenderContext = { args?: object; isError?: boolean };
type TextToolResult = AgentToolResult<unknown> & { isError?: boolean };

const MAX_SUMMARY_LENGTH = 96;
const TASK_OPS: readonly TaskOp[] = ["create", "update", "list", "get"];

function compactInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength = MAX_SUMMARY_LENGTH): string {
  const chars = Array.from(compactInline(value));
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join("")}…` : chars.join("");
}

function formatArgValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function readOp(args: Record<string, unknown> | undefined): TaskOp | undefined {
  const op = args?.op;
  return TASK_OPS.find(candidate => candidate === op);
}

function formatCallArgs(op: TaskOp | undefined, args: Record<string, unknown>): string[] {
  switch (op) {
    case "create":
    case "update": {
      const count = Array.isArray(args.tasks) ? args.tasks.length : undefined;
      return [count !== undefined ? `${op} (${count})` : op];
    }
    case "get": {
      const id = formatArgValue(args.taskId);
      return [id ? `get #${id}` : "get"];
    }
    case "list":
      return ["list"];
    default:
      return [];
  }
}

export function renderTaskToolCall(rawArgs: object | undefined, theme: ToolTheme) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs as Record<string, unknown> : {};
  const target = formatCallArgs(readOp(args), args).join(" · ") || undefined;
  return renderToolCall("Task", target, theme);
}

function summarizeCreate(text: string): string[] | undefined {
  const match = text.match(/^Created (\d+) tasks?: (.+)$/m);
  if (!match) return undefined;
  return [`action: created ${match[1]} · ${truncate(match[2], 72)}`];
}

function summarizeUpdate(text: string): string[] | undefined {
  const applied = text.match(/^Updated (\d+) tasks?: (.+)$/m);
  const rejected = text.match(/^Rejected (\d+) tasks?: (.+)$/m);
  if (!applied && !rejected) return undefined;
  const lines: string[] = [];
  if (applied) lines.push(`action: updated ${applied[1]} · ${truncate(applied[2], 72)}`);
  if (rejected) lines.push(`rejected: ${rejected[1]} · ${truncate(rejected[2], 72)}`);
  return lines;
}

type TaskListSection = "Running" | "Ready" | "Blocked" | "Completed";

const TASK_LIST_SECTIONS: readonly TaskListSection[] = ["Running", "Ready", "Blocked", "Completed"];
const TASK_LIST_LABELS: Record<TaskListSection, string> = {
  Running: "running",
  Ready: "ready",
  Blocked: "blocked",
  Completed: "completed",
};

function stripTaskAnnotations(subject: string): string {
  return subject.replace(/ \[[^\]]+\]$/g, "");
}

function summarizeTaskPreview(line: string): string | undefined {
  const match = line.match(/^#(\S+) \[[^\]]+\] (.+)$/);
  if (!match) return undefined;
  return `#${match[1]} ${truncate(stripTaskAnnotations(match[2]), 56)}`;
}

function isTaskListSection(line: string): line is TaskListSection {
  return TASK_LIST_SECTIONS.some(section => section === line);
}

function summarizeList(text: string): string[] | undefined {
  if (text.trim() === "No tasks found") return ["tasks: none"];

  const grouped = new Map<TaskListSection, string[]>();
  let currentSection: TaskListSection | undefined;
  const fallbackTaskLines: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (isTaskListSection(line)) {
      currentSection = line;
      if (!grouped.has(currentSection)) grouped.set(currentSection, []);
      continue;
    }
    if (!/^#\S+ \[[^\]]+\]/.test(line)) continue;
    if (currentSection) {
      grouped.get(currentSection)!.push(line);
    } else {
      fallbackTaskLines.push(line);
    }
  }

  if (grouped.size === 0 && fallbackTaskLines.length === 0) return undefined;
  if (grouped.size === 0) grouped.set("Ready", fallbackTaskLines);

  const total = Array.from(grouped.values()).reduce((sum, lines) => sum + lines.length, 0);
  const counts = TASK_LIST_SECTIONS
    .filter(section => (grouped.get(section)?.length ?? 0) > 0)
    .map(section => `${grouped.get(section)!.length} ${TASK_LIST_LABELS[section]}`)
    .join(", ");
  const lines = [`tasks: ${total} total${counts ? ` · ${counts}` : ""}`];

  for (const section of ["Running", "Ready"] as const) {
    const first = grouped.get(section)?.[0];
    if (!first) continue;
    const preview = summarizeTaskPreview(first);
    if (preview) lines.push(`next: ${TASK_LIST_LABELS[section]} ${preview}`);
    break;
  }

  return lines;
}

function summarizeGet(text: string): string[] | undefined {
  if (text.trim() === "Task not found") return ["task: not found"];
  const taskMatch = text.match(/^Task #(\S+): (.+)$/m);
  const statusMatch = text.match(/^Status: (.+)$/m);
  if (!taskMatch) return undefined;

  const lines = [`task: #${taskMatch[1]} ${truncate(taskMatch[2])}`];
  const statusParts = [statusMatch?.[1]];
  const owner = text.match(/^Owner: (.+)$/m)?.[1];
  if (owner) statusParts.push(`owner ${owner}`);
  const blockedBy = text.match(/^Blocked by: (.+)$/m)?.[1];
  const blocks = text.match(/^Blocks: (.+)$/m)?.[1];
  if (blockedBy) statusParts.push(`blocked by ${blockedBy}`);
  if (blocks) statusParts.push(`blocks ${blocks}`);
  lines.push(`status: ${truncate(statusParts.filter(Boolean).join(" · "))}`);
  return lines;
}

function summarizeFallback(text: string): string[] {
  const firstLine = firstMeaningfulLine(text);
  return firstLine ? [`action: ${truncate(firstLine)}`] : ["status: complete · no output"];
}

function summarizeResult(op: TaskOp | undefined, text: string): string[] {
  switch (op) {
    case "create": return summarizeCreate(text) ?? summarizeFallback(text);
    case "update": return summarizeUpdate(text) ?? summarizeFallback(text);
    case "list": return summarizeList(text) ?? summarizeFallback(text);
    case "get": return summarizeGet(text) ?? summarizeFallback(text);
    default:
      // No op context (shouldn't happen for well-formed calls): best-effort parse.
      return summarizeList(text) ?? summarizeGet(text) ?? summarizeCreate(text) ?? summarizeUpdate(text) ?? summarizeFallback(text);
  }
}

function errorSummary(text: string): string {
  return `error: ${truncate(firstMeaningfulLine(text) || "Task tool failed")}`;
}

function hasUsefulExpansion(op: TaskOp | undefined, rawText: string, isError: boolean): boolean {
  if (!rawText.trim()) return false;
  const rawLines = rawText.split(/\r\n?|\n/).filter(line => line.trim().length > 0);
  if (isError) return rawLines.length > 1 || Array.from(firstMeaningfulLine(rawText)).length > MAX_SUMMARY_LENGTH;
  if (op === "list" || op === "get") return true;
  return rawLines.length > 1 || Array.from(compactInline(rawText)).length > MAX_SUMMARY_LENGTH;
}

export function renderTaskToolResult(
  result: TextToolResult | undefined,
  options: TaskRenderOptions,
  theme: ToolTheme,
  context?: TaskRenderContext,
) {
  const rawText = extractToolText(result);
  if (options.expanded) return renderToolExpanded(rawText);

  const op = readOp(context?.args as Record<string, unknown> | undefined);
  const isError = Boolean(context?.isError || result?.isError);
  const lines = options.isPartial
    ? [`status: running Task${op ? ` ${op}` : ""}`]
    : isError
      ? [errorSummary(rawText)]
      : summarizeResult(op, rawText);
  return renderToolSummary(lines, theme, {
    expandable: !options.isPartial && hasUsefulExpansion(op, rawText, isError),
  });
}
