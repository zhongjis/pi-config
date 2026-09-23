vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { decodeHistory, GraphHistoryStore, snapshotHistory } from "../src/graph/history.js";
import { mergeWorkflowRuns } from "../src/graph/history-view.js";
import { toPaneSource } from "../src/graph/pane/render.js";
import { createWorkflowTask } from "../src/graph/task.js";
import { applyPanelKey, initialPanelState, renderPanelLines } from "../src/ui/observability-panel.js";
import { handleWorkflowDialogKey, initialWorkflowDialogState, layoutWorkflowDialog, resolveWorkflowDialog, WorkflowDialog } from "../src/ui/workflow-dialog.js";
import { showWorkflowsMenu } from "../src/ui/workflow-menu.js";

function required<T>(value: T | null | undefined): T {
  assert.ok(value != null);
  return value;
}

describe("historical graph presentation", () => {
  const live = createWorkflowTask({ id: "same", script: "" });
  Object.assign(live, { status: "failed", endTime: Date.now() });
  live.workflowProgress = [{ type: "workflow_agent", index: 0, label: "failed-node", state: "error", recordId: "private", error: "private" }];
  const snapshot = required(snapshotHistory(live));
  snapshot.omittedNodeCount = 3;

  it("merges live first by ID without making runtime handles for history", () => {
    expect(mergeWorkflowRuns([live], [snapshot]).get("same")).toBe(live);
    const history = required(mergeWorkflowRuns([], [snapshot]).get("same"));
    expect(history).not.toHaveProperty("abortController");
    expect(history).not.toHaveProperty("control");
  });

  it("keeps the centered inspector's metadata-only history disclosure unchanged", () => {
    const history = required(mergeWorkflowRuns([], [snapshot]).get("same"));
    const source = toPaneSource(history);
    const state = initialWorkflowDialogState();
    const input = { ...source, state, width: 140 };
    const dialog = layoutWorkflowDialog(input).flat().map(segment => segment.text).join("\n");
    const runs = [{ id: history.id, name: "history", status: history.status, source }];
    const panelState = applyPanelKey(runs, applyPanelKey(runs, initialPanelState(), "j", { width: 140 }).state, "j", { width: 140 }).state;
    const pane = renderPanelLines(runs, panelState, { width: 140 }).flat().map(segment => segment.text).join("\n");
    for (const rendered of [dialog, pane]) {
      expect(rendered).toContain("History snapshot · read-only · content not retained");
      expect(rendered).toContain("3 nodes omitted");
      expect(rendered).toContain("Details were not retained in history.");
      expect(rendered).not.toMatch(/c convo|p pause|s skip|r retry|x stop|private|Available once the agent starts/);
    }
    for (const key of ["p", "s", "r", "x", "c"]) {
      expect(handleWorkflowDialogKey(key, state, resolveWorkflowDialog(input))?.action).toBeUndefined();
      expect(applyPanelKey(runs, panelState, key, { width: 140 }).action).toBeUndefined();
    }
  });
});

it("opens history from the menu without wiring any supervision or conversation actions", async () => {
  const task = createWorkflowTask({ id: "menu", script: "" });
  Object.assign(task, { status: "failed", endTime: Date.now() });
  task.workflowProgress = [{ type: "workflow_agent", index: 0, label: "node", state: "error", recordId: "private" }];
  const tasks = mergeWorkflowRuns([], [required(snapshotHistory(task))]);
  const open = vi.fn();
  const notify = vi.fn();
  const custom: ExtensionContext["ui"]["custom"] = (factory) => new Promise((resolve, reject) => {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    void Promise.resolve(factory({ requestRender() {} } as TUI, theme as Parameters<typeof factory>[1], {} as Parameters<typeof factory>[2], resolve)).then(component => {
      expect(component).toBeInstanceOf(WorkflowDialog);
      if (!(component instanceof WorkflowDialog)) throw new Error("Expected workflow dialog");
      expect(component.render(140).join("\n")).toContain("History snapshot");
      for (const key of ["p", "s", "r", "x", "c"]) component.handleInput(key);
      component.handleInput("\x1b");
    }).catch(reject);
  });
  const ui: Partial<ExtensionContext["ui"]> = { custom, notify };
  const ctx = { ui: ui as ExtensionContext["ui"] };
  await showWorkflowsMenu(ctx, { tasks, getCtx: () => ctx, getRecord: vi.fn(), viewAgentConversation: open });
  expect(open).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

it("keeps history metadata-private and ambiguous labels flat rather than reconstructing containment", () => {
  const task = createWorkflowTask({ id: "legacy", script: "" });
  Object.assign(task, { status: "completed", endTime: Date.now() });
  task.workflowProgress = [{ type: "workflow_agent", index: 0, label: "Research · iteration 2 · item 4", state: "done", presentation: { kind: "agent", name: "private name", parentInstanceId: "private parent", iteration: 2, itemIndex: 3 } }];
  const saved = required(decodeHistory(JSON.stringify({ version: 1, runs: [snapshotHistory(task)] })).runs[0]);
  expect(JSON.stringify(saved)).not.toMatch(/private name|private parent|presentation|topology/);
  const history = required(mergeWorkflowRuns([], [saved]).get("legacy"));
  const runs = [{ id: "legacy", name: "legacy", status: history.status, source: toPaneSource(history) }];
  const lines = renderPanelLines(runs, initialPanelState(), { width: 120 }).map(line => line.map(segment => segment.text).join(""));
  expect(lines.join("\n")).toContain("1 unclassified node");
  expect(lines.join("\n")).toContain("Flat fallback");
  expect(lines.join("\n")).not.toContain("↻ Iteration");
  expect(lines.find(line => line.includes("Research · iteration"))).toMatch(/^     └─ ✓ done/);
});

it("round-trips v2 hierarchy, decisions and selected flow without retaining private runtime data", async () => {
  const task = createWorkflowTask({ id: "roundtrip", script: "PRIVATE_SCRIPT", meta: { name: "context-gather", description: "Configured\nworkflow description" } });
  Object.assign(task, { status: "completed", startTime: 0, endTime: 160000, args: "PRIVATE_INPUT", value: "PRIVATE_OUTPUT" });
  const add = (binding: string, data: Partial<import("../src/graph/progress.js").WorkflowAgentEntry>) => {
    task.workflowProgress.push({ type: "workflow_agent", index: task.workflowProgress.length, label: "display", state: "done", nodeBinding: binding, instanceId: `${binding}-UUID`, recordId: "PRIVATE_RECORD", promptPreview: "PRIVATE_PROMPT", resultPreview: "PRIVATE_RESULT", ...data });
  };
  add("PRIVATE_OWNER", { label: "Research", presentation: { kind: "bounded_feedback", name: "Research", iterations: [{ iteration: 1, decision: "continue" }, { iteration: 2, decision: "sufficient" }] } });
  for (const iteration of [1, 2]) {
    const work = `PRIVATE_WORK_${iteration}`;
    const evaluator = `PRIVATE_EVAL_${iteration}`;
    add(work, { label: `Work ${iteration}`, dependents: [evaluator], presentation: { kind: "fanout", name: "Gather evidence", parentInstanceId: "PRIVATE_OWNER-UUID", iteration, role: "work" } });
    for (let itemIndex = 0; itemIndex < (iteration === 1 ? 4 : 1); itemIndex++) {
      add(`PRIVATE_ITEM_${iteration}_${itemIndex}`, { label: `Work ${iteration} item ${itemIndex + 1}`, deps: [work], dependents: [evaluator], presentation: { kind: "agent", name: "Worker", parentInstanceId: `${work}-UUID`, iteration, itemIndex, role: "item" } });
    }
    add(evaluator, { label: `Evaluator ${iteration}`, presentation: { kind: "agent", name: "Evaluate evidence", parentInstanceId: "PRIVATE_OWNER-UUID", iteration, role: "evaluator" } });
  }
  add("PRIVATE_SYNTHESIS", { label: "Synthesis", deps: ["PRIVATE_OWNER"], presentation: { kind: "agent", name: "Synthesize context", connections: [{ binding: "PRIVATE_OWNER", direction: "upstream", kind: "conditional" }] } });
  const saved = required(snapshotHistory(task));
  const json = JSON.stringify({ version: 2, runs: [saved] });
  expect(json).not.toMatch(/PRIVATE_|instanceId|nodeBinding|recordId|promptPreview|resultPreview/);
  const directory = await mkdtemp(join(tmpdir(), "history-topology-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  let loaded: Awaited<ReturnType<typeof GraphHistoryStore.load>>;
  try {
    const store = await GraphHistoryStore.load("topology-session");
    store.capture(task);
    await store.flush();
    const file = await readFile(join(directory, "local/topology-session/graph-history.json"), "utf8");
    expect(JSON.parse(file).version).toBe(2);
    expect(file).not.toMatch(/PRIVATE_|instanceId|nodeBinding|recordId|promptPreview|resultPreview/);
    loaded = await GraphHistoryStore.load("topology-session");
    expect(loaded.runs).toEqual(decodeHistory(json).runs);
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
  const history = required(mergeWorkflowRuns([], loaded.runs).get(task.id));
  expect(history.meta?.description).toBe("Configured workflow description");
  const runs = [{ id: task.id, name: "context-gather", status: history.status, source: toPaneSource(history) }];
  const render = (state = initialPanelState()) => renderPanelLines(runs, state, { width: 140 }).map(line => line.map(segment => segment.text).join(""));
  const lines = render();
  expect(lines.join("\n")).toContain("8 agents · 3 coordination nodes · 2 iterations");
  expect(lines.join("\n")).toContain("Configured workflow description");
  expect(lines.join("\n")).not.toMatch(/unclassified|Flat fallback|PRIVATE_/);
  expect(lines.filter(line => /↻ Iteration/.test(line))).toHaveLength(2);
  expect(lines.filter(line => /continue|sufficient/.test(line))).toHaveLength(2);
  expect(lines.filter(line => /item [1-4]/.test(line))).toHaveLength(5);
  const liveLines = renderPanelLines([{ ...runs[0], source: toPaneSource(task) }], initialPanelState(), { width: 140 }).map(line => line.map(segment => segment.text).join(""));
  expect(lines.filter(line => /✓ done|↻ Iteration/.test(line))).toEqual(liveLines.filter(line => /✓ done|↻ Iteration/.test(line)));
  let state = initialPanelState();
  for (let i = 0; i < 15; i++) state = applyPanelKey(runs, state, "j", { width: 140 }).state;
  expect(render(state).join("\n")).toContain("upstream: Research (conditional)");
  expect(typeof state.cursor?.kind === "string" && state.cursor.kind === "node" && typeof state.cursor.id).toBe("number");
  const itemState = { ...initialPanelState(), cursor: { kind: "node" as const, id: 4 } };
  const liveItemState = { ...itemState, cursor: { kind: "node" as const, id: "PRIVATE_ITEM_1_2" } };
  const liveItem = renderPanelLines([{ ...runs[0], source: toPaneSource(task) }], liveItemState, { width: 140 }).map(line => line.map(segment => segment.text).join(""));
  const flow = (rows: string[]) => rows.slice(rows.indexOf(" Flow"), rows.findIndex(row => row === " Prompt"));
  expect(flow(render(itemState))).toEqual(flow(liveItem));
  expect(flow(render(itemState)).join("\n")).toContain("Evaluator 1");
});
