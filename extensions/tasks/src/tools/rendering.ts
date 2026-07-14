import { type AgentToolResult, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type TaskToolName = "TaskCreate" | "TaskList" | "TaskGet" | "TaskUpdate" | "TaskOutput" | "TaskStop";
type ToolTheme = Pick<Theme, "fg" | "bold">;
type TaskRenderOptions = Pick<ToolRenderResultOptions, "expanded" | "isPartial">;
type TaskRenderContext = { args?: object; isError?: boolean };
type TextToolResult = AgentToolResult<unknown> & { isError?: boolean };

function styleToolTitle(theme: ToolTheme, text: string): string {
  const bold = theme.bold ? theme.bold(text) : text;
  return theme.fg ? theme.fg("toolTitle", bold) : bold;
}

function styleMuted(theme: Pick<ToolTheme, "fg">, text: string): string {
  return theme.fg ? theme.fg("muted", text) : text;
}

function renderSummaryLines(lines: string[], theme: Pick<ToolTheme, "fg">): Text {
  const rendered = lines
    .map((line, index) => `${index === lines.length - 1 ? "└─" : "├─"} ${line}`)
    .map(line => styleMuted(theme, line))
    .join("\n");
  return new Text(rendered, 0, 0);
}

function getResultText(result: TextToolResult | undefined): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter(part => part?.type === "text")
    .map(part => (typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

function truncate(value: string, maxLength = 96): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function firstBodyLine(text: string): string | undefined {
  const body = text.split(/\n\n+/).slice(1).join("\n\n").trim();
  return body.split(/\r?\n/).map(line => line.trim()).find(Boolean);
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
      return [id ? `#${id}` : undefined, fields.length > 0 ? fields.join(", ") : undefined].filter(Boolean) as string[];
    }
    case "TaskOutput": {
      const id = formatArgValue(args.task_id);
      const block = args.block === false ? "block=false" : undefined;
      return [id ? `#${id}` : undefined, block].filter(Boolean) as string[];
    }
    case "TaskStop": {
      const id = formatArgValue(args.task_id) ?? formatArgValue(args.shell_id);
      return id ? [`#${id}`] : [];
    }
  }
}

export function renderTaskToolCall(toolName: TaskToolName, rawArgs: object | undefined, theme: ToolTheme): Text {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs as Record<string, unknown> : {};
  const parts = formatCallArgs(toolName, args);
  const suffix = parts.length > 0 ? ` · ${styleMuted(theme, parts.join(" · "))}` : "";
  return new Text(`▸ ${styleToolTitle(theme, toolName)}${suffix}`, 0, 0);
}

function summarizeCreate(text: string): string[] | undefined {
  const match = text.match(/^Task #(\S+) created successfully: (.+)$/);
  if (!match) return undefined;
  return [`task: #${match[1]} created · ${truncate(match[2])}`];
}

type TaskListSection = "Running" | "Ready" | "Blocked" | "Completed";

const TASK_LIST_SECTIONS: TaskListSection[] = ["Running", "Ready", "Blocked", "Completed"];
const TASK_LIST_PREVIEW_ORDER: TaskListSection[] = ["Ready", "Running", "Completed", "Blocked"];
const TASK_LIST_LABELS: Record<TaskListSection, string> = {
  Running: "running",
  Ready: "ready",
  Blocked: "blocked",
  Completed: "completed",
};

function stripTaskAnnotations(subject: string): string {
  return subject.replace(/ \[[^\]]+\]$/g, "");
}

function summarizeTaskPreview(lines: string[]): string {
  const previews = lines.map(line => {
    const match = line.match(/^#(\S+) \[[^\]]+\] (.+)$/);
    if (!match) return undefined;
    return `#${match[1]} ${truncate(stripTaskAnnotations(match[2]), 40)}`;
  }).filter(Boolean) as string[];
  const more = previews.length > 3 ? ` +${previews.length - 3}` : "";
  return `${previews.slice(0, 3).join(", ")}${more}`;
}

function summarizeList(text: string): string[] | undefined {
  if (text.trim() === "No tasks found") return ["tasks: none"];
  const grouped = new Map<TaskListSection, string[]>();
  let currentSection: TaskListSection | undefined;
  const fallbackTaskLines: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if ((TASK_LIST_SECTIONS as string[]).includes(line)) {
      currentSection = line as TaskListSection;
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
  const countSummary = TASK_LIST_SECTIONS
    .filter(section => (grouped.get(section)?.length ?? 0) > 0)
    .map(section => `${grouped.get(section)!.length} ${TASK_LIST_LABELS[section]}`)
    .join(", ");
  const lines = [`tasks: ${total} total${countSummary ? ` · ${countSummary}` : ""}`];

  for (const section of TASK_LIST_PREVIEW_ORDER) {
    const sectionLines = grouped.get(section);
    if (!sectionLines || sectionLines.length === 0) continue;
    lines.push(`${TASK_LIST_LABELS[section]}: ${summarizeTaskPreview(sectionLines)}`);
    if (lines.length >= 4) break;
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
  lines.push(`status: ${statusParts.filter(Boolean).join(" · ")}`);
  return lines;
}

function summarizeUpdate(text: string): string[] | undefined {
  let match = text.match(/^Task #(\S+) not found$/);
  if (match) return [`task: #${match[1]} not found`];

  match = text.match(/^Updated task #(\S+)\s*(.*?)(?: \(warning: (.*)\))?$/);
  if (!match) return undefined;
  const fields = match[2]?.trim();
  const lines = [`task: #${match[1]} updated${fields ? ` · ${fields}` : ""}`];
  if (match[3]) lines.push(`warning: ${truncate(match[3])}`);
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
  return [`task: #${match[1]} stopped`];
}


function summarizeFallback(toolName: TaskToolName, text: string): string[] {
  const firstLine = text.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  if (!firstLine) return ["status: complete"];
  const keyword = toolName === "TaskOutput" ? "output" : "status";
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
  const firstLine = text.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  return `error: ${truncate(firstLine ?? "Task tool failed")}`;
}

export function renderTaskToolResult(
  toolName: TaskToolName,
  result: TextToolResult | undefined,
  options: TaskRenderOptions,
  theme: Pick<ToolTheme, "fg">,
  context?: TaskRenderContext,
): Text {
  const rawText = getResultText(result);
  if (options.expanded) return new Text(rawText, 0, 0);
  if (options.isPartial) return renderSummaryLines([`status: running ${toolName}`], theme);
  if (context?.isError || result?.isError) return renderSummaryLines([errorSummary(rawText)], theme);
  return renderSummaryLines(summarizeResult(toolName, rawText), theme);
}
