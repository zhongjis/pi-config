import { type AgentToolResult, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import {
  extractToolText,
  firstMeaningfulLine,
  renderToolCall,
  renderToolExpanded,
  renderToolSummary,
} from "../../../lib/tool-output.js";

type TaskToolName = "TaskCreate" | "TaskList" | "TaskGet" | "TaskUpdate" | "TaskOutput" | "TaskStop";
type ToolTheme = Pick<Theme, "fg" | "bold">;
type TaskRenderOptions = Pick<ToolRenderResultOptions, "expanded" | "isPartial">;
type TaskRenderContext = { args?: object; isError?: boolean };
type TextToolResult = AgentToolResult<unknown> & { isError?: boolean };

const MAX_SUMMARY_LENGTH = 96;

function compactInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength = MAX_SUMMARY_LENGTH): string {
  const chars = Array.from(compactInline(value));
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join("")}…` : chars.join("");
}

function firstBodyLine(text: string): string {
  const body = text.split(/\n\n+/).slice(1).join("\n\n");
  return firstMeaningfulLine(body);
}

function formatArgValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function formatCallArgs(toolName: TaskToolName, args: Record<string, unknown>): string[] {
  switch (toolName) {
    case "TaskCreate": {
      const subject = formatArgValue(args.subject);
      return subject ? [`"${truncate(subject, 60)}"`] : [];
    }
    case "TaskList":
      return [];
    case "TaskGet": {
      const id = formatArgValue(args.taskId);
      return id ? [`#${id}`] : [];
    }
    case "TaskUpdate": {
      const id = formatArgValue(args.taskId);
      const fields = ["status", "subject", "description", "activeForm", "owner", "metadata", "addBlocks", "addBlockedBy"]
        .filter(key => args[key] !== undefined);
      return [id ? `#${id}` : undefined, fields.length > 0 ? fields.join(", ") : undefined]
        .filter((part): part is string => part !== undefined);
    }
    case "TaskOutput": {
      const id = formatArgValue(args.task_id);
      const block = args.block === false ? "block=false" : undefined;
      return [id ? `#${id}` : undefined, block].filter((part): part is string => part !== undefined);
    }
    case "TaskStop": {
      const id = formatArgValue(args.task_id) ?? formatArgValue(args.shell_id);
      return id ? [`#${id}`] : [];
    }
  }
}

export function renderTaskToolCall(toolName: TaskToolName, rawArgs: object | undefined, theme: ToolTheme) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs as Record<string, unknown> : {};
  const target = formatCallArgs(toolName, args).join(" · ") || undefined;
  return renderToolCall(toolName, target, theme);
}

function summarizeCreate(text: string): string[] | undefined {
  const match = text.match(/^Task #(\S+) created successfully: (.+)$/);
  if (!match) return undefined;
  return [`action: created #${match[1]} · ${truncate(match[2])}`];
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

function summarizeUpdate(text: string): string[] | undefined {
  const notFound = text.match(/^Task #(\S+) not found$/);
  if (notFound) return [`action: task #${notFound[1]} not found`];

  const updated = text.match(/^Updated task #(\S+)\s*(.*)$/);
  if (!updated) return undefined;
  const warning = updated[2].match(/^(.*?) \(warning: (.*)\)$/);
  const fields = (warning?.[1] ?? updated[2]).trim();
  const lines = [`action: updated #${updated[1]}${fields ? ` · ${fields}` : ""}`];
  if (warning?.[2]) lines.push(`warning: ${truncate(warning[2])}`);
  return lines;
}

function summarizeOutput(text: string): string[] | undefined {
  const match = text.match(/^Task #(\S+) \(([^)]+)\)(?: exit code: (\S+))?/);
  if (!match) return undefined;
  const lines = [`status: ${match[2]}${match[3] ? ` · exit code ${match[3]}` : ""}`];
  const preview = firstBodyLine(text);
  if (preview) lines.push(`output: ${truncate(preview)}`);
  return lines;
}

function summarizeStop(text: string): string[] | undefined {
  const match = text.match(/^Task #(\S+) stopped successfully$/);
  if (!match) return undefined;
  return [`outcome: stopped #${match[1]}`];
}

function summarizeFallback(toolName: TaskToolName, text: string): string[] {
  const firstLine = firstMeaningfulLine(text);
  if (!firstLine) return ["status: complete · no output"];
  const keyword = toolName === "TaskOutput" ? "output" : toolName === "TaskStop" ? "outcome" : "action";
  return [`${keyword}: ${truncate(firstLine)}`];
}

function summarizeResult(toolName: TaskToolName, text: string): string[] {
  switch (toolName) {
    case "TaskCreate": return summarizeCreate(text) ?? summarizeFallback(toolName, text);
    case "TaskList": return summarizeList(text) ?? summarizeFallback(toolName, text);
    case "TaskGet": return summarizeGet(text) ?? summarizeFallback(toolName, text);
    case "TaskUpdate": return summarizeUpdate(text) ?? summarizeFallback(toolName, text);
    case "TaskOutput": return summarizeOutput(text) ?? summarizeFallback(toolName, text);
    case "TaskStop": return summarizeStop(text) ?? summarizeFallback(toolName, text);
  }
}

function errorSummary(text: string): string {
  return `error: ${truncate(firstMeaningfulLine(text) || "Task tool failed")}`;
}

function hasUsefulExpansion(toolName: TaskToolName, rawText: string, isError: boolean): boolean {
  if (!rawText.trim()) return false;
  const rawLines = rawText.split(/\r\n?|\n/).filter(line => line.trim().length > 0);
  if (isError) return rawLines.length > 1 || Array.from(firstMeaningfulLine(rawText)).length > MAX_SUMMARY_LENGTH;
  if (toolName === "TaskList" || toolName === "TaskGet" || toolName === "TaskOutput") return true;
  return rawLines.length > 1 || Array.from(compactInline(rawText)).length > MAX_SUMMARY_LENGTH;
}

export function renderTaskToolResult(
  toolName: TaskToolName,
  result: TextToolResult | undefined,
  options: TaskRenderOptions,
  theme: ToolTheme,
  context?: TaskRenderContext,
) {
  const rawText = extractToolText(result);
  if (options.expanded) return renderToolExpanded(rawText);

  const isError = Boolean(context?.isError || result?.isError);
  const lines = options.isPartial
    ? [`status: running ${toolName}`]
    : isError
      ? [errorSummary(rawText)]
      : summarizeResult(toolName, rawText);
  return renderToolSummary(lines, theme, {
    expandable: !options.isPartial && hasUsefulExpansion(toolName, rawText, isError),
  });
}
