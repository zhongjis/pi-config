/** State-specific transcript reports for live workflows and retained notifications. */
import { keyHint } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { firstMeaningfulLine, renderToolExpanded, renderToolSummary } from "../../../lib/tool-output.js";
import { isWorkflowEntryData } from "../graph/entry-validation.js";
import { outcomeLabel } from "../graph/outcome.js";
import { buildPhaseGroups, collapse, displayState, elapsedMs, formatDuration, type GraphRunAgentEntry, sizeWarning, stats } from "../graph/progress.js";
import type { Theme } from "./agent-widget.js";
import { formatModel, formatThinking, type GraphRunCardInput, REPLAYED_ANNOTATION } from "./graph-run-card.js";

function resultSummary(value: unknown): string {
  if (value === undefined) return "no output";
  if (typeof value === "string") return firstMeaningfulLine(value) || "no output";
  if (Array.isArray(value)) return `array · ${value.length} item${value.length === 1 ? "" : "s"}`;
  if (value !== null && typeof value === "object") return "structured result";
  return String(value);
}

const childStatuses = { queued: "Queued", running: "Running", done: "Completed", failed: "Failed", skipped: "Skipped", blocked: "Blocked", interrupted: "Interrupted" } as const;

function childStatus(entry: GraphRunAgentEntry, active: boolean): string {
  return entry.cached ? "Replayed" : childStatuses[displayState(entry, active)];
}

function observedCounts(agents: readonly GraphRunAgentEntry[], active: boolean): string {
  if (agents.length === 0) return "No agents observed";
  const counts = new Map<string, number>();
  for (const entry of agents) {
    const status = childStatus(entry, active).toLowerCase();
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts].map(([status, count]) => `${count} agent${count === 1 ? "" : "s"} ${status}`).join(" · ");
}

/** State-specific report shared by live tool rows and retained snapshots. */
export function renderGraphRunCard(input: GraphRunCardInput, theme: Theme): Component {
  return {
    invalidate() {},
    render(width) {
      if (!Number.isFinite(width) || width <= 0) return [];
      const { task } = input;
      const { agents, logs } = collapse(input.progress);
      const active = task.status === "running" || task.status === "paused";
      const running = agents.filter(entry => displayState(entry, active) === "running");
      const queued = agents.filter(entry => displayState(entry, active) === "queued");
      const childErrors = agents.some(entry => entry.state === "error");
      const status = { running: "Running", paused: "Paused", completed: outcomeLabel(task.outcome), failed: "Execution failed", killed: "Stopped" }[task.status];
      const counts = observedCounts(agents, active);
      const activity = [running.length ? `${running.length} active` : "", queued.length ? `${queued.length} queued` : ""].filter(Boolean).join(" · ") || "waiting for graph run progress";
      const name = task.graphRunName ?? input.meta?.name ?? "Graph run";
      const identity = input.showToolTitle ? `Graph run ${status.toLowerCase()} · ${name}` : status;
      const summary = task.status === "completed" ? resultSummary(task.value) : task.error ? firstMeaningfulLine(task.error) : active ? activity : counts;
      const fields = task.value !== null && typeof task.value === "object" && !Array.isArray(task.value) ? Object.keys(task.value) : [];
      const first = running[0] ?? queued[0];
      const current = first ? [first.label, first.agentType, running.length > 1 ? `+${running.length - 1} active tasks` : ""].filter(Boolean).join(" · ") : counts;
      if (!input.expanded) {
        if (!input.showToolTitle) {
          const graphRunStats = stats(input.progress, input.agentCount ?? agents.length);
          const outcome =
            task.outcome === undefined ? "not declared"
            : task.outcome.status === "succeeded" ? "succeeded"
            : `${task.outcome.status}: ${task.outcome.reason}`;
          const execution = task.status === "killed" ? "stopped" : task.status;
          const completed = `${graphRunStats.done} agent${graphRunStats.done === 1 ? "" : "s"} completed`;
          const executionDetail = task.status === "completed" ? completed : task.status === "failed" && graphRunStats.failedCount > 0 ? `${graphRunStats.failedCount} agent${graphRunStats.failedCount === 1 ? "" : "s"} failed` : active && agents.length === 0 && task.id ? `${counts} · id: ${task.id}` : counts;
          const result = task.status === "completed" ? fields.length ? fields.join(", ") : summary : task.error ? firstMeaningfulLine(task.error) : active ? activity : counts;
          return renderToolSummary(
            [`outcome: ${outcome}`, `execution: ${execution} · ${executionDetail}`, `result: ${result}`],
            theme,
            { expandable: true, expandLabel: `${active ? "details" : "result and diagnostics"} · /agents › Graph runs` },
          ).render(width);
        }
        const second = active ? (!first && task.id ? `id: ${task.id} · ${current}` : current) : [task.status === "completed" ? "Execution: completed" : "", counts, task.status === "completed" ? fields.length ? `${input.showToolTitle ? "returned" : "fields:"} ${fields.join(", ")}` : input.showToolTitle ? summary : "" : ""].filter(Boolean).join(" · ");
        const lines = [
          input.showToolTitle ? `${identity}${task.status === "failed" && task.error ? ` · ${firstMeaningfulLine(task.error)}` : ""}` : `${status} · ${summary}`,
          second,
          `${keyHint("app.tools.expand", active ? "details" : "result and diagnostics")} · /agents › Graph runs`,
        ];
        const color = task.status === "failed" || (task.status === "completed" && task.outcome?.status === "failed") ? "error" : childErrors || task.status === "killed" || task.status === "paused" || task.outcome?.status === "partial" ? "warning" : task.status === "completed" && task.outcome?.status === "succeeded" ? "success" : "accent";
        return lines.map((line, index) => truncateToWidth(theme.fg(index === 0 ? color : "muted", line.replace(/\r\n?|\n/g, " ")), Math.floor(width), "…"));
      }

      const components: Component[] = [];
      const text = (value: string) => components.push(renderToolExpanded(value));
      text(`${identity} · ${counts}\nExecution: ${task.status}\n`);
      if (active) {
        text(`Activity\n${activity}\n${current}${logs.length ? `\n${logs.at(-1)}` : ""}`);
      } else if (task.status === "failed" || task.status === "killed") {
        text(`Error\n${task.error || (task.status === "killed" ? "Graph run stopped." : "Graph run failed.")}\n/agents › Graph runs — inspect diagnostics before retrying the run`);
      } else {
        text("Result");
        if (typeof task.value === "string" && task.value.trim()) {
          components.push(renderToolExpanded(task.value, { format: "markdown" }));
        } else {
          text(task.value === undefined || task.value === "" ? "No output returned." : JSON.stringify(task.value, null, 2));
        }
      }

      text("\nAgents");
      for (const group of buildPhaseGroups(input.progress, input.meta?.phases)) {
        text(`  ${group.title}${group.agents.length ? "" : " · not started"}`);
        for (const entry of group.agents) text(`    ${childStatus(entry, active)}  ${entry.label}${entry.agentType ? ` · ${entry.agentType}` : ""}`);
      }
      if (!agents.length) text("  No agents observed.");
      const tools = task.totalToolCalls ?? agents.reduce((sum, entry) => sum + (entry.toolCalls ?? 0), 0);
      const tokens = input.totalTokens ?? agents.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
      text(`\nRun${task.id ? `\nID ${task.id}` : ""}\nDuration ${formatDuration(elapsedMs(task, input.now ?? Date.now()))}\nUsage ${tools} tools · ${tokens.toLocaleString("en-US")} tokens${task.resumedFrom ? `\nResumed from ${task.resumedFrom}` : ""}`);
      if (sizeWarning({ scheduledAgents: Math.max(input.agentCount ?? 0, agents.length), startedAgents: stats(input.progress).started, totalTokens: tokens, agentCap: input.agentCap, tokenCap: input.tokenCap })) text("Large graph run · /agents › Graph runs to inspect");
      const artifacts = [["Script", task.scriptPath], ["Full result", task.resultPath]].filter(([, path]) => path);
      if (artifacts.length) text(`\nArtifacts\n${artifacts.map(([label, path]) => `${label}\n${path}`).join("\n")}`);
      if (task.resultArtifactError) text(`\n${task.resultArtifactError}\nComplete returned content remains in this report.`);
      text("\n/agents › Graph runs — inspect agents and conversations while retained in this session");

      if (agents.length || logs.length) text("\nRetained details");
      for (const entry of agents) {
        text(`${entry.label}${entry.agentType ? ` · ${entry.agentType}` : ""} · ${childStatus(entry, active)}`);
        const metadata = [formatModel(entry, { canonical: true }), formatThinking(entry), entry.cached ? REPLAYED_ANNOTATION : undefined, entry.recordId ? `Conversation ${entry.recordId}` : undefined, entry.attempt ? `Attempt ${entry.attempt}${entry.lastAttemptReason ? ` · ${entry.lastAttemptReason}` : ""}` : undefined, entry.toolCalls !== undefined ? `${entry.toolCalls} tools` : undefined, entry.tokens !== undefined ? `${entry.tokens} tokens` : undefined, entry.durationMs !== undefined ? formatDuration(entry.durationMs) : undefined].filter(Boolean);
        if (metadata.length) text(metadata.join(" · "));
        for (const [label, value] of [["Prompt", entry.promptPreview], ["Result", entry.resultPreview], ["Error", entry.error]]) if (value) text(`${label}\n${value}`);
      }
      if (logs.length) text(`Logs\n${logs.join("\n")}`);
      return components.flatMap(component => component.render(width));
    },
  };
}

/**
 * The card for a session entry, from the JSON a flag-launched run persisted.
 *
 * The same layout the tool result uses, not a second one — the only difference
 * is `showToolTitle`, because a session entry stands alone and nothing above it
 * says what it is. Returns undefined for an entry with no data, which is what
 * pi's renderer contract wants for "nothing to draw".
 */
export function renderGraphRunEntryCard(data: unknown, theme: Theme, expanded = false): Component | undefined {
  if (data === undefined) return undefined;
  if (!isWorkflowEntryData(data)) {
    const raw = JSON.stringify(data, null, 2) ?? "No graph run data.";
    return expanded ? renderToolExpanded(raw) : renderToolSummary([firstMeaningfulLine(raw)], theme, { expandable: true });
  }
  return renderGraphRunCard({
    progress: data.progress,
    task: { ...data, graphRunName: data.name },
    meta: data.meta,
    agentCount: data.agentCount,
    totalTokens: data.totalTokens,
    showToolTitle: true,
    expanded,
  }, theme);
}
