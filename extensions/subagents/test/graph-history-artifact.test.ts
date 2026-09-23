vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workflowNodeArtifactId, readWorkflowNodeDetail } from "../src/graph/history-artifact.js";
import { createOutputFilePath, outputFilePath, writeInitialEntry } from "../src/output-file.js";
import { decodeHistory, snapshotHistory } from "../src/graph/history.js";
import { mergeWorkflowRuns } from "../src/graph/history-view.js";
import { toPaneSource } from "../src/graph/pane/render.js";
import { createWorkflowTask } from "../src/graph/task.js";
import { GraphRunReporter } from "../src/graph/graph-run-adapter.js";
import { GraphInstances } from "../src/graph/graph-instance-id.js";
import { initialPanelState, renderPanelLines } from "../src/ui/observability-panel.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "history-artifact-"));
  dirs.push(cwd);
  const sessionId = "session", runId = "workflow-run";
  const alias = workflowNodeArtifactId(runId, 7);
  const path = createOutputFilePath(cwd, alias, sessionId);
  dirs.push(dirname(dirname(path)));
  writeInitialEntry(path, alias, "PROMPT_FIXTURE", cwd);
  const entry = (type: string, content: unknown) => appendFileSync(path, JSON.stringify({ isSidechain: true, agentId: alias, cwd, type, message: { role: type, content } }) + "\n");
  const read = (index = 7) => readWorkflowNodeDetail({ cwd, sessionId }, runId, index);
  return { cwd, sessionId, runId, alias, path, entry, read };
}

describe("historical node artifacts", () => {
  it("aliases only run and validated history index with bounded path-safe names", () => {
    const hostile = "../../private-binding/\\\0".repeat(1000);
    const alias = workflowNodeArtifactId(hostile, 7);
    expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,100}$/);
    expect(alias).toBe(workflowNodeArtifactId(hostile, 7));
    expect(alias).not.toContain("private-binding");
    expect(alias).not.toBe(workflowNodeArtifactId(hostile, 8));
    expect(alias).not.toBe(workflowNodeArtifactId("another-run", 7));
    for (const index of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => workflowNodeArtifactId("run", index)).toThrow();
  });

  it("maps private v2 execution identities to the assigned history index", () => {
    const task = createWorkflowTask({ id: "run", script: "" });
    const node = { type: "agent", agent: "fixture", prompt: "PROMPT" } as const;
    const instance = new GraphInstances("run").add("binding", { nodeKey: "binding" });
    const reporter = new GraphRunReporter(task, { version: 2, nodes: { binding: node }, edges: [] });
    expect(reporter.nodeIndex("binding")).toBeUndefined();
    reporter.registerNode("binding", node, { dependencies: [], instance });
    reporter.update("binding", { status: "completed", attempt: 1, output: "OUTCOME" });
    expect(reporter.nodeIndex(instance.instanceId)).toBe(instance.ordinal);
    expect(task.workflowProgress.find(entry => entry.type === "workflow_agent")?.index).toBe(instance.ordinal);
    expect(reporter.nodeIndex("missing")).toBeUndefined();
  });

  it("keeps ordinary output filenames unchanged", () => {
    const f = fixture();
    expect(outputFilePath(f.cwd, "ordinary-agent-id", f.sessionId)).toBe(join(dirname(f.path), "ordinary-agent-id.output"));
  });

  it("extracts only initial user and final assistant text with exact scope", () => {
    const f = fixture();
    f.entry("assistant", [{ type: "text", text: "INTERMEDIATE" }]);
    f.entry("toolResult", [{ type: "text", text: "TOOL_SECRET" }]);
    f.entry("user", "FOLLOWUP");
    f.entry("assistant", [{ type: "thinking", thinking: "HIDDEN" }, { type: "toolCall", arguments: { secret: "TOOL_SECRET" } }, { type: "text", text: "FINAL_FIXTURE" }]);
    f.entry("assistant", [{ type: "toolCall", arguments: {} }]);
    expect(f.read()).toEqual({ prompt: "PROMPT_FIXTURE", outcome: "FINAL_FIXTURE" });
    expect(f.read(8)).toBeUndefined();
    expect(readWorkflowNodeDetail({ cwd: f.cwd, sessionId: "other" }, f.runId, 7)).toBeUndefined();
    expect(readWorkflowNodeDetail({ cwd: f.cwd, sessionId: "../session" }, f.runId, 7)).toBeUndefined();
    expect(readWorkflowNodeDetail({ cwd: f.cwd + "-other", sessionId: f.sessionId }, f.runId, 7)).toBeUndefined();
    // encodeCwd collisions must not cross the exact-cwd boundary.
    expect(readWorkflowNodeDetail({ cwd: f.cwd.replaceAll("/", "-"), sessionId: f.sessionId }, f.runId, 7)).toBeUndefined();
    expect(readWorkflowNodeDetail(f, "other", 7)).toBeUndefined();
  });

  it("never creates missing artifact directories and fails safely on malformed or oversized data", () => {
    const f = fixture();
    const missing = outputFilePath(f.cwd, f.alias, "missing");
    expect(readWorkflowNodeDetail({ cwd: f.cwd, sessionId: "missing" }, f.runId, 7)).toBeUndefined();
    expect(existsSync(dirname(missing))).toBe(false);
    appendFileSync(f.path, "{invalid\n");
    expect(f.read()).toBeUndefined();
    writeFileSync(f.path, "x".repeat(2 * 1024 * 1024));
    expect(f.read()).toBeUndefined();
    writeFileSync(f.path, JSON.stringify({ type: "user", message: { content: "RAW_SECRET" } }));
    expect(f.read()).toBeUndefined();
  });

  it("bounds returned text and marks the preview", () => {
    const f = fixture();
    f.entry("assistant", [{ type: "text", text: "x".repeat(30000) }]);
    const detail = f.read();
    expect(detail?.outcome?.length).toBeLessThan(17000);
    expect(detail?.outcome).toContain("truncated");
  });

  it("resolves only selected history detail after metadata reload, outside the centered source", () => {
    const f = fixture();
    f.entry("assistant", [{ type: "text", text: "FINAL_FIXTURE" }]);
    const task = createWorkflowTask({ id: f.runId, script: "PRIVATE_SCRIPT" });
    Object.assign(task, { status: "completed", endTime: Date.now() });
    task.workflowProgress = [7, 8].map(index => ({ type: "workflow_agent", index, label: `Node ${index}`, state: "done", promptPreview: "PRIVATE_PROMPT", resultPreview: "PRIVATE_OUTPUT", recordId: "PRIVATE_UUID", presentation: { kind: "agent", name: `Node ${index}` } }));
    const json = JSON.stringify({ version: 2, runs: [snapshotHistory(task)] });
    expect(json).not.toMatch(/PRIVATE_|outputFile|artifact|alias|prompt|resultPreview/);
    const resolver = vi.fn((runId: string, index: number) => readWorkflowNodeDetail(f, runId, index));
    const history = mergeWorkflowRuns([], decodeHistory(json).runs, resolver).get(f.runId);
    if (history?.type !== "history") throw new Error("Expected history");
    expect(resolver).not.toHaveBeenCalled();
    const source = toPaneSource(history);
    expect(source).not.toHaveProperty("readNodeDetail");
    const run = { id: history.id, name: history.workflowName, status: history.status, source, readHistoricalDetail: history.readNodeDetail };
    const state = { ...initialPanelState(), cursor: { kind: "node" as const, id: 7 }, expandedSections: ["prompt", "outcome"] };
    const rendered = renderPanelLines([run], state, { width: 140 }).flat().map(segment => segment.text).join("\n");
    expect(rendered).toContain("History snapshot · read-only metadata · session artifacts resolved on demand");
    expect(rendered).toContain("PROMPT_FIXTURE");
    expect(rendered).toContain("FINAL_FIXTURE");
    expect(rendered).not.toMatch(/PRIVATE_|content not retained|TOOL_SECRET|HIDDEN/);
    expect(resolver.mock.calls).toEqual([[f.runId, 7]]);
    resolver.mockClear();
    const unavailable = renderPanelLines([run], { ...state, cursor: { kind: "node", id: 8 } }, { width: 140 }).flat().map(segment => segment.text).join("\n");
    expect(unavailable).toMatch(/unavailable/i);
    expect(resolver.mock.calls).toEqual([[f.runId, 8]]);
  });
});
