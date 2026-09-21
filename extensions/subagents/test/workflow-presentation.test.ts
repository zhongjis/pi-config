// Exercise real terminal-cell wrapping rather than the unit harness's ASCII stub.
vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import assert from "node:assert/strict";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { workflowEntryData } from "../src/graph/entry.js";
import { elapsedMs, stats, type WorkflowAgentEntry } from "../src/graph/progress.js";
import { createWorkflowTask, pauseWorkflowTask, resolveResumeTarget, resumeWorkflowTask, updateWorkflowProgressBatch } from "../src/graph/task.js";
import type { AgentRecord } from "../src/types.js";
import { AgentWidget } from "../src/ui/agent-widget.js";
import { FleetList, type FleetWorkflow } from "../src/ui/fleet-list.js";
import { renderWorkflowCard, renderWorkflowEntryCard } from "../src/ui/workflow-report.js";

const theme = { fg: (_: string, s: string) => `\x1b[36m${s}\x1b[39m`, bold: (s: string) => `\x1b[1m${s}\x1b[22m` };
const agent: WorkflowAgentEntry = { type: "workflow_agent", index: 7, label: "child", state: "progress", recordId: "child-id", model: "actual-sdk-model", thinking: "off" };
const widths = [0, ...Array.from({ length: 12 }, (_, index) => index + 1), 20, 40, 80, 120];
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const fits = (lines: string[], width: number) => {
  for (const line of lines) {
    expect(line).not.toMatch(/[\r\n]/);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
};
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("workflow reports", () => {
  it("resolves the configured expand hint and preserves malformed entry data expanded", () => {
    const hint = vi.spyOn(codingAgent, "keyHint").mockReturnValue("configured-key details");
    const task = createWorkflowTask({ id: "wf_test", script: "" });
    expect(plain(renderWorkflowCard({ task, progress: [] }, theme).render(80))).toContain("configured-key");
    expect(hint).toHaveBeenCalledWith("app.tools.expand", expect.any(String));
    const malformed: unknown = { retained: "raw-marker", status: "unknown" };
    const card = renderWorkflowEntryCard(malformed as Parameters<typeof renderWorkflowEntryCard>[0], theme, true);
    assert.ok(card);
    expect(plain(card.render(80))).toContain("raw-marker");
  });

  it("renders completed graph tool details as a structured tree", () => {
    vi.spyOn(codingAgent, "keyHint").mockImplementation((_key, label) => `Ctrl+O ${label}`);
    const task = createWorkflowTask({ id: "wf_tree", script: "" });
    task.status = "completed";
    task.value = { summary: "done", relevantFiles: [], constraints: [], unknowns: [] };
    task.workflowProgress = Array.from({ length: 5 }, (_, index) => ({ ...agent, index, state: "done" }));
    expect(plain(renderWorkflowCard({ task, progress: task.workflowProgress }, theme).render(120)).split("\n")).toEqual([
      "├─ outcome: not declared",
      "├─ execution: completed · 5 agents completed",
      "├─ result: summary, relevantFiles, constraints, unknowns",
      "└─ Ctrl+O result and diagnostics · /agents › Workflows",
    ]);
  });
  it.each(["running", "paused", "completed", "failed", "killed"] as const)("keeps %s compact across terminal widths without modifying data", status => {
    const task = createWorkflowTask({ id: "wf_test", script: "", startTime: 100 });
    task.status = status;
    task.value = "結果🙂 é " + "x".repeat(200);
    task.error = status === "failed" ? "failure-marker " + "y".repeat(200) : undefined;
    task.workflowProgress = [agent, { type: "workflow_log", message: "line1\nline2" }];
    const before = JSON.stringify(workflowEntryData(task));
    for (const width of widths) {
      const rows = renderWorkflowCard({ task, progress: task.workflowProgress }, theme).render(width);
      fits(rows, width);
      expect(rows.length).toBeLessThanOrEqual(4);
      const expanded = renderWorkflowCard({ task, progress: task.workflowProgress, expanded: true }, theme).render(width);
      fits(expanded, width);
    }
    expect(JSON.stringify(workflowEntryData(task))).toBe(before);
  });

  it("retains the complete terminal report, per-child previews, and logs expanded after serialization", () => {
    const task = createWorkflowTask({ id: "wf_test", script: "", startTime: 100 });
    task.status = "completed";
    task.value = Array.from({ length: 60 }, (_, i) => `value-${i}`).join("\n");
    task.workflowProgress = [{ ...agent, state: "done", promptPreview: "prompt-tail", resultPreview: "child-tail" }, { type: "workflow_log", message: "log-tail" }];
    const restored = JSON.parse(JSON.stringify(workflowEntryData(task)));
    const card = renderWorkflowEntryCard(restored, theme, true);
    assert.ok(card);
    const report = plain(card.render(40));
    for (const marker of ["value-0", "value-59", "prompt-tail", "child-tail", "log-tail", "actual-sdk-model", "thinking: off"]) expect(report).toContain(marker);
    expect(report.indexOf("value-59")).toBeLessThan(report.indexOf("actual-sdk-model"));
  });

  it("collapses updates for counts and rejects a paused journal as a new resume target", () => {
    const task = createWorkflowTask({ id: "wf_test", script: "", startTime: 100, journalPath: "/journal" });
    const control = { pause: vi.fn(), resume: vi.fn(), isPaused: () => false, skip: () => true, retry: () => true };
    task.control = control;
    updateWorkflowProgressBatch(task, [agent, { ...agent, state: "done", tokens: 10 }]);
    expect(stats(task.workflowProgress)).toMatchObject({ total: 1, done: 1, running: false });
    expect(task.totalTokens).toBe(10);
    expect(pauseWorkflowTask(task, 200)).toBe(true);
    expect(elapsedMs(task, 1000)).toBe(100);
    expect(resolveResumeTarget(task.id, new Map([[task.id, task]]))).toMatchObject({ ok: false });
    expect(resumeWorkflowTask(task, 1000)).toBe(true);
    expect(elapsedMs(task, 1100)).toBe(200);
  });
  it("keeps direct graph execution states truthful without a stale run id", () => {
    vi.spyOn(codingAgent, "keyHint").mockReturnValue("expand details");
    const task = createWorkflowTask({ id: "wf_ack", script: "" });
    task.status = "running";

    const collapsed = renderWorkflowCard({ task, progress: [] }, theme).render(80);
    expect(plain(collapsed)).toContain("execution: running · No agents observed · id: wf_ack");
    expect(collapsed.length).toBeLessThanOrEqual(4);

    task.workflowProgress = [agent];
    const afterChild = plain(renderWorkflowCard({ task, progress: task.workflowProgress }, theme).render(80));
    expect(afterChild).toContain("execution: running · 1 agent running");
    expect(afterChild).not.toContain("id: wf_ack");

    task.status = "failed";
    task.error = "failure";
    expect(plain(renderWorkflowCard({ task, progress: [] }, theme).render(80))).toContain("execution: failed");
    expect(plain(renderWorkflowCard({ task, progress: [] }, theme).render(80))).not.toContain("id: wf_ack");

    task.status = "killed";
    expect(plain(renderWorkflowCard({ task, progress: [] }, theme).render(80))).toContain("execution: stopped");
    expect(plain(renderWorkflowCard({ task, progress: [] }, theme).render(80))).not.toContain("id: wf_ack");
  });
});


it("hides owned children only from ordinary UI and allows a workflow-only fleet to open", async () => {
  const records = [
    { id: "ordinary", session: {}, status: "running", startedAt: 1 },
    { id: "owned", workflowId: "wf_test", session: {}, status: "running", startedAt: 1 },
  ] as AgentRecord[];
  const manager = new AgentManager();
  vi.spyOn(manager, "listAgents").mockReturnValue(records);
  const widget = new AgentWidget(manager, new Map());
  const widgetSetWidget = vi.fn();
  widget.setUICtx({ setWidget: widgetSetWidget, setStatus: vi.fn() });
  widget.update();
  expect(widgetSetWidget).toHaveBeenCalledWith("agents", expect.any(Function), { placement: "aboveEditor" });
  const fleet = new FleetList(manager, new Map());
  const fleetSetWidget = vi.fn();
  fleet.setUICtx({ setWidget: fleetSetWidget, getEditorText: () => "", onTerminalInput: () => () => {}, notify() {}, custom: vi.fn() });
  fleet.setEnabled(true);
  fleet.update();
  expect(fleetSetWidget).toHaveBeenCalledWith("fleet", expect.any(Function), { placement: "belowEditor" });
  expect(manager.listAgents()).toHaveLength(2);
  records.splice(0, 1);
  widget.update();
  fleet.update();
  expect(widgetSetWidget).toHaveBeenLastCalledWith("agents", undefined);
  expect(fleetSetWidget).toHaveBeenLastCalledWith("fleet", undefined);
  const run: FleetWorkflow = { id: "wf_test", name: "run", status: "running", doneCount: 0, totalCount: 1, startedAt: 1, tokens: 0 };
  const open = vi.fn(async () => {});
  fleet.setWorkflowSource(() => [run], open);
  fleet.update();
  expect(fleet.handleKey("\x1b[B")).toEqual({ consume: true });
  fleet.handleKey("\x1b[B"); fleet.handleKey("\r");
  await Promise.resolve();
  expect(open).toHaveBeenCalledWith("wf_test");
  fleet.dispose(); widget.dispose();
});

describe("workflow disclosure states", () => {
  it.each([
    [undefined, "no output"], [null, "null"], ["", "no output"], [[], "array · 0 items"],
    [[1, 2], "array · 2 items"], [{ research: 1, review: 2 }, "research, review"],
  ])("summarizes returned %j without stale activity", (value, summary) => {
    const task = createWorkflowTask({ id: "wf_empty", script: "" });
    task.status = "completed"; task.value = value;
    const text = plain(renderWorkflowCard({ task, progress: [{ type: "workflow_log", message: "stale-activity" }] }, theme).render(120));
    expect(text).toContain(summary);
    expect(text).not.toContain("stale-activity");
  });

  it("distinguishes queued work, child errors, and replayed work in the retained roster", () => {
    const task = createWorkflowTask({ id: "wf_states", script: "" });
    const entries: WorkflowAgentEntry[] = [
      { ...agent, index: 0, label: "waiting", agentType: "fixture", queuedAt: 10 },
      { ...agent, index: 1, label: "failure", state: "error", error: "child-failure" },
      { ...agent, index: 2, label: "skip", state: "error", skipped: true },
      { ...agent, index: 3, label: "block", state: "error", blocked: true },
      { ...agent, index: 4, label: "reused", state: "done", cached: true },
    ];
    expect(plain(renderWorkflowCard({ task, progress: entries }, theme).render(120))).toContain("1 queued");
    task.status = "completed"; task.value = { result: "answer" };
    const report = plain(renderWorkflowCard({ task, progress: entries, expanded: true }, theme).render(120));
    for (const marker of ["Completed", "Execution: completed", "Interrupted", "Failed", "Skipped", "Blocked", "Replayed"]) expect(report).toContain(marker);
    expect(report).not.toContain("5 agents completed");
  });
});

it("fits serialized notification identities, structured Unicode results, and full artifact paths", () => {
  const task = createWorkflowTask({ id: "wf_width", script: "" });
  task.status = "completed";
  task.workflowName = "界🙂 é\r\n".repeat(8);
  task.scriptPath = "/tmp/" + "長".repeat(70);
  task.resultPath = "/tmp/" + "result".repeat(30);
  task.value = { ["字段".repeat(30)]: "\u001b[36m結果🙂 é\u001b[0m\r\n".repeat(10), tail: "json-tail" };
  task.workflowProgress = [{ ...agent, state: "done", label: "子🙂\nagent", agentType: "fixture" }];
  const snapshot: unknown = JSON.parse(JSON.stringify(workflowEntryData(task)));
  for (const expanded of [false, true]) {
    const component = renderWorkflowEntryCard(snapshot, theme, expanded);
    assert.ok(component);
    for (const width of widths) {
      const rows = component.render(width);
      fits(rows, width);
      if (!expanded) expect(rows.length).toBeLessThanOrEqual(3);
    }
    if (expanded) {
      const report = plain(component.render(40));
      expect(report).toContain("json-tail");
      expect(report.replace(/\n/g, "")).toContain(task.resultPath);
    }
  }
});

it("does not advertise a reserved journal as a written artifact after a zero-child failure", () => {
  const task = createWorkflowTask({ id: "wf_failure", script: "", journalPath: "/reserved-unwritten-journal" });
  task.status = "failed"; task.error = "script-failed";
  const report = plain(renderWorkflowCard({ task, progress: [], expanded: true }, theme).render(120));
  expect(report).toContain("script-failed");
  expect(report).not.toContain("/reserved-unwritten-journal");
  expect(report).not.toContain("can reuse successful journal entries");
});

it("snapshots JSON-serializable object returns without requiring structured-clone compatibility", () => {
  const task = createWorkflowTask({ id: "wf_json", script: "" });
  task.status = "completed";
  task.value = { date: new Date("2026-09-14T00:00:00Z"), answer: "retained-json-answer", omitted: () => true };
  const snapshot = workflowEntryData(task);
  expect(snapshot.value).toEqual({ date: "2026-09-14T00:00:00.000Z", answer: "retained-json-answer" });
  const report = renderWorkflowEntryCard(snapshot, theme, true);
  assert.ok(report);
  expect(plain(report.render(80))).toContain("retained-json-answer");
});
