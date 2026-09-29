import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isGraphRunId } from "./graph-snapshot-path.js";
import type { AgentGraph } from "./ir.js";
import { parseTrace, type ReplayReport, replayTrace } from "./replay.js";
import { GRAPH_EXTENSIONS, readGraphFile, resolveSavedGraph } from "./saved-graph.js";
import { GRAPH_TRACE_BYTES, graphTracePath } from "./trace.js";
import { validateGraph } from "./validate.js";

const USAGE = "Usage: /agent-graph-replay <runId> <graph>  (graph: saved name or .graph.json/.graph.yaml path)";
const WIDTH = 100;
type Notice = { readonly text: string; readonly level: "info" | "error" };
const error = (text: string): Notice => ({ text, level: "error" });
const line = (text: string): string => {
  const safe = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
  return safe.length > WIDTH ? `${safe.slice(0, WIDTH - 1)}…` : safe;
};
const json = (value: unknown): string => value === undefined ? "none" : JSON.stringify(value);

/** Display-only replay of an exact-session trace against a validated candidate graph. */
export function runReplayCommand(args: string, cwd: string, sessionId: string): Notice {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return error(USAGE);
  const [runId, graphArg] = parts as [string, string];
  if (!isGraphRunId(runId)) return error(`Invalid graph run ID "${line(runId)}".\n${USAGE}`);
  let text: string;
  try {
    const fd = openSync(graphTracePath(cwd, sessionId, runId), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > GRAPH_TRACE_BYTES * 2) return error(`Graph trace for ${runId} is not a readable trace file.`);
      text = readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return error(`No graph trace for ${runId} in this session.`);
    return error(`Could not read the graph trace for ${runId}.`);
  }
  const trace = parseTrace(text);
  if ("error" in trace) return error(`Graph trace for ${runId} is unreadable: ${trace.error}`);
  const source = GRAPH_EXTENSIONS.some(extension => graphArg.endsWith(extension))
    ? readGraphFile(isAbsolute(graphArg) ? graphArg : resolve(cwd, graphArg))
    : resolveSavedGraph(graphArg, cwd);
  if (!source.ok) return error(source.message);
  const verdict = validateGraph(source.graph);
  if (!verdict.ok) return error(`Invalid agent graph:\n- ${verdict.errors.join("\n- ")}`);
  return { text: formatReplay(runId, graphArg, replayTrace(trace, source.graph as AgentGraph)), level: "info" };
}

export function formatReplay(runId: string, graphName: string, report: ReplayReport): string {
  const rows = [`Replay ${runId} against ${graphName} · baseline ${report.recordedStatus ?? "unfinished"}${report.truncated ? " · trace truncated" : ""}`];
  rows.push(report.selfConsistency.ok ? "Self-consistency: ok" : `Self-consistency: ${report.selfConsistency.mismatches.length} mismatch(es)`);
  for (const mismatch of report.selfConsistency.mismatches) rows.push(`  ${mismatch.id}  recorded ${mismatch.recorded} → replayed ${mismatch.replayed}`);
  const nodes = report.nodes.filter(node => node.baseline !== node.candidate);
  const edges = report.edges.filter(edge => edge.baselineActive !== edge.candidateActive);
  const loops = [...new Set([...Object.keys(report.loopCounts.baseline), ...Object.keys(report.loopCounts.candidate)])]
    .filter(key => (report.loopCounts.baseline[key] ?? 0) !== (report.loopCounts.candidate[key] ?? 0));
  const outputs = [...new Set([...Object.keys(report.outputs.baseline), ...Object.keys(report.outputs.candidate)])]
    .filter(key => json(report.outputs.baseline[key]) !== json(report.outputs.candidate[key]));
  if (nodes.length) rows.push("Nodes:", ...nodes.map(node => `  ${node.id}  ${node.baseline} → ${node.candidate}`));
  const active = (value: boolean) => value ? "active" : "inactive";
  if (edges.length) rows.push("Edges:", ...edges.map(edge => `  ${edge.from}→${edge.to}  ${active(edge.baselineActive)} → ${active(edge.candidateActive)}`));
  if (loops.length) rows.push("Loops:", ...loops.map(key => `  ${key}  ${report.loopCounts.baseline[key] ?? 0} → ${report.loopCounts.candidate[key] ?? 0}`));
  if (json(report.outcome.baseline) !== json(report.outcome.candidate)) rows.push(`Outcome: ${json(report.outcome.baseline)} → ${json(report.outcome.candidate)}`);
  if (outputs.length) rows.push(`Outputs changed: ${outputs.join(", ")}`);
  if (report.needsLiveRun.length) rows.push(`Needs live run: ${report.needsLiveRun.join(", ")}`);
  for (const message of report.errors) rows.push(`Replay stopped: ${message}`);
  if (!nodes.length && !edges.length && !loops.length && !outputs.length && !report.needsLiveRun.length && !report.errors.length) rows.push("No differences.");
  return rows.map(line).join("\n");
}
