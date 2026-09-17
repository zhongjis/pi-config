// Exercise real terminal-cell wrapping rather than the unit harness's ASCII stub.
vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import assert from "node:assert/strict";
import type * as codingAgent from "@earendil-works/pi-coding-agent";
import { type OverlayHandle, stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import {
  handleWorkflowDialogKey,
  initialWorkflowDialogState,
  layoutWorkflowDialog,
  plainWorkflowDialogLines,
  resolveWorkflowDialog,
  WorkflowDialog,
  workflowAgentModel,
} from "../src/ui/workflow-dialog.js";
import { showWorkflowDialog, showWorkflowsMenu } from "../src/ui/workflow-menu.js";
import type { WorkflowAgentEntry, WorkflowEntry } from "../src/graph/progress.js";
import { createWorkflowTask } from "../src/graph/task.js";

const theme = { fg: (_: string, text: string) => `\x1b[36m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
const widths = [0, 1, 2, 8, 20, 40, 80, 120];
const agent: WorkflowAgentEntry = {
  type: "workflow_agent", index: 7, label: "child", state: "progress", recordId: "child-id",
  agentType: "chengfeng", model: "haiku,gpt-5.6-luna,qwen", modelId: "gpt-5.6-luna", thinking: "off",
};
const source = () => ({ task: { status: "running" as const, startTime: 100 }, progress: [agent] });
const text = (input: Parameters<typeof layoutWorkflowDialog>[0]) => plainWorkflowDialogLines(layoutWorkflowDialog(input)).join("\n");
const fits = (lines: string[], width: number) => {
  for (const line of lines) {
    expect(stripTerminalSequences(line)).not.toMatch(/[\r\n]/);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
};
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("workflow inspector model", () => {
  it("shows only effective runtime models and honest unresolved states", () => {
    const queued = { ...agent, index: 1, label: "queued", state: "start" as const, queuedAt: 10, modelId: undefined, recordId: undefined };
    const unresolved = { ...agent, index: 2, label: "starting", modelId: undefined };
    expect(workflowAgentModel(queued, "queued")).toBe("model pending");
    expect(workflowAgentModel(unresolved, "running")).toBe("model pending");
    expect(workflowAgentModel(agent, "running")).toBe("gpt-5.6-luna");
    const rendered = text({ ...source(), progress: [queued, agent], state: initialWorkflowDialogState(), width: 120 });
    expect(rendered).toContain("model pending");
    expect(rendered).toContain("gpt-5.6-luna");
    expect(rendered).not.toContain("haiku,gpt-5.6-luna,qwen");
    expect(rendered).not.toContain("asked");
  });

  it("keeps one phase-grouped roster and explicit lifecycle words", () => {
    const progress: WorkflowEntry[] = [
      { type: "workflow_phase", index: 0, title: "Research" },
      { ...agent, index: 0, label: "running", phaseIndex: 0, phaseTitle: "Research" },
      { ...agent, index: 1, label: "queued", state: "start", queuedAt: 10, phaseIndex: 0, phaseTitle: "Research", modelId: undefined },
      { type: "workflow_phase", index: 1, title: "Verify" },
      { ...agent, index: 2, label: "finished", state: "done", phaseIndex: 1, phaseTitle: "Verify" },
    ];
    const rendered = text({
      task: { status: "running", startTime: 100 }, progress,
      meta: { name: "audit", description: "", phases: [{ title: "Research" }, { title: "Verify" }, { title: "Report" }] },
      state: initialWorkflowDialogState(), width: 120,
    });
    for (const marker of ["Research", "Verify", "Report", "Running", "Queued", "Completed", "Waiting for workflow to schedule"]) {
      expect(rendered).toContain(marker);
    }
  });

  it("renders every terminal distinction and paused scheduling semantics explicitly", () => {
    const progress: WorkflowAgentEntry[] = [
      { ...agent, index: 0, label: "failed", state: "error", error: "failed" },
      { ...agent, index: 1, label: "blocked", state: "error", blocked: true, error: "blocked" },
      { ...agent, index: 2, label: "skipped", state: "error", skipped: true },
      { ...agent, index: 3, label: "stopped", state: "progress" },
      { ...agent, index: 4, label: "replayed", state: "done", cached: true, modelId: undefined },
    ];
    const rendered = text({ task: { status: "completed", startTime: 100 }, progress, state: initialWorkflowDialogState(), width: 120 });
    for (const marker of ["Failed", "Blocked", "Skipped", "Stopped", "Replayed", "model not run"]) expect(rendered).toContain(marker);
    const queued = { ...agent, index: 5, label: "queued", state: "start" as const, queuedAt: 10, modelId: undefined };
    const paused = text({ task: { status: "paused", startTime: 100 }, progress: [queued], state: initialWorkflowDialogState(5), width: 120 });
    expect(paused).toContain("Execution: paused");
    expect(paused).toContain("no new agents start");
  });

  it("preserves selection by stable entry index as progress grows", () => {
    const chosen = { ...agent, index: 12, label: "chosen" };
    const state = initialWorkflowDialogState(12);
    const before = resolveWorkflowDialog({ ...source(), progress: [chosen], state, width: 120 });
    const after = resolveWorkflowDialog({ ...source(), progress: [{ ...agent, index: 4 }, chosen, { ...agent, index: 20 }], state, width: 120 });
    expect(before.selectedEntry?.label).toBe("chosen");
    expect(after.selectedEntry?.label).toBe("chosen");
    expect(handleWorkflowDialogKey("j", state, after)?.state.selectedIndex).toBe(20);
  });
});

describe("workflow inspector interaction", () => {
  it("routes controls through stable entry and record ids", () => {
    const state = initialWorkflowDialogState(7);
    const view = resolveWorkflowDialog({ ...source(), state, width: 120 });
    for (const [key, action] of [["x", { kind: "kill" }], ["p", { kind: "pause" }], ["s", { kind: "skip", index: 7 }], ["r", { kind: "retry", index: 7 }], ["c", { kind: "open", recordId: "child-id" }]] as const) {
      expect(handleWorkflowDialogKey(key, state, view)?.action).toEqual(action);
    }
    const paused = resolveWorkflowDialog({ ...source(), task: { status: "paused", startTime: 100 }, state, width: 120 });
    expect(handleWorkflowDialogKey("p", state, paused)?.action).toEqual({ kind: "resume" });
  });

  it("uses side-by-side detail when wide and explicit drill-in/back when narrow", () => {
    const state = initialWorkflowDialogState(7);
    const wide = resolveWorkflowDialog({ ...source(), state, width: 120 });
    expect(wide.narrow).toBe(false);
    expect(text({ ...source(), state, width: 120 })).toContain("Current activity");
    const narrow = resolveWorkflowDialog({ ...source(), state, width: 40 });
    expect(narrow.narrow).toBe(true);
    const opened = handleWorkflowDialogKey("\r", state, narrow);
    assert.ok(opened);
    expect(opened.state.level).toBe("detail");
    expect(text({ ...source(), state: opened.state, width: 40 })).toContain("Current activity");
    expect(handleWorkflowDialogKey("\x1b", opened.state, resolveWorkflowDialog({ ...source(), state: opened.state, width: 40 }))?.state.level).toBe("roster");
  });

  it("puts terminal outcome before prompt and exposes contextual controls on demand", () => {
    const state = initialWorkflowDialogState(7);
    const progress = [{ ...agent, state: "done" as const, resultPreview: "outcome-marker", promptPreview: "prompt-marker" }];
    const collapsed = text({ task: { status: "completed", startTime: 100 }, progress, state, width: 120 });
    expect(collapsed.indexOf("outcome-marker")).toBeLessThan(collapsed.indexOf("prompt-marker"));
    expect(collapsed).not.toContain("x stop");
    const help = handleWorkflowDialogKey("?", state, resolveWorkflowDialog({ task: { status: "running", startTime: 100 }, progress: [agent], state, width: 120 }));
    assert.ok(help);
    const expanded = text({ ...source(), state: help.state, width: 120 });
    expect(expanded).toContain("? less");
    expect(expanded).toContain("x stop");
    expect(expanded).toContain("s skip");
  });

  it("fits every row and stops refreshing after settlement or disposal", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn<TUI["requestRender"]>();
    const task = { status: "running" as "running" | "completed", startTime: 100 };
    const dialog = new WorkflowDialog({ requestRender, terminal: { rows: 40 } } as unknown as TUI, () => ({ task, progress: [agent] }), theme, vi.fn());
    for (const width of widths) fits(dialog.render(width), width);
    vi.advanceTimersByTime(500);
    expect(requestRender).toHaveBeenCalled();
    task.status = "completed";
    vi.advanceTimersByTime(500);
    expect(vi.getTimerCount()).toBe(0);
    dialog.dispose();
  });
});

it("hides the inspector while its child conversation is open, then restores it", async () => {
  const task = createWorkflowTask({ id: "wf_test", script: "" });
  task.workflowProgress = [agent];
  let dialog: WorkflowDialog | undefined;
  let finishViewer: (() => void) | undefined;
  const setHidden = vi.fn();
  const custom: codingAgent.ExtensionContext["ui"]["custom"] = (factory, options) => new Promise((resolve, reject) => {
    void Promise.resolve(factory({ requestRender() {} } as TUI, theme as codingAgent.Theme, {} as codingAgent.KeybindingsManager, resolve)).then(component => {
      assert.ok(component instanceof WorkflowDialog);
      dialog = component;
      assert.ok(options?.onHandle);
      options.onHandle({ setHidden } as unknown as OverlayHandle);
    }).then(undefined, reject);
  });
  const ui: Pick<codingAgent.ExtensionContext["ui"], "notify" | "custom"> = { notify: vi.fn(), custom };
  const ctx = { ui: ui as codingAgent.ExtensionContext["ui"] };
  const record = { id: "child-id" } as AgentRecord;
  const viewAgentConversation = vi.fn(() => new Promise<void>(resolve => { finishViewer = resolve; }));
  const opened = showWorkflowDialog(ctx, task, { tasks: new Map([[task.id, task]]), getRecord: () => record, getCtx: () => ctx, viewAgentConversation });
  await vi.waitFor(() => expect(dialog).toBeDefined());
  dialog?.handleInput("c");
  expect(setHidden).toHaveBeenLastCalledWith(true);
  finishViewer?.();
  await Promise.resolve(); await Promise.resolve();
  expect(setHidden).toHaveBeenLastCalledWith(false);
  dialog?.handleInput("\x1b");
  await opened;
});

it("passes live outcome through the inspector and labels menu lifecycle as execution", async () => {
  const task = createWorkflowTask({ id: "wf_outcome", script: "" });
  task.status = "completed";
  task.outcome = { status: "failed", reason: "verification failed" };
  task.value = { retained: "evidence" };
  const custom: codingAgent.ExtensionContext["ui"]["custom"] = factory => new Promise((resolve, reject) => {
    void Promise.resolve(factory({ requestRender() {} } as TUI, theme as codingAgent.Theme, {} as codingAgent.KeybindingsManager, resolve)).then(component => {
      assert.ok(component instanceof WorkflowDialog);
      expect(stripTerminalSequences(component.render(120).join("\n"))).toContain("Outcome: failed — verification failed");
      component.handleInput("\x1b");
    }).then(undefined, reject);
  });
  const select = vi.fn(async () => undefined);
  const ui = { custom, select, notify: vi.fn() } as unknown as codingAgent.ExtensionContext["ui"];
  const ctx = { ui };
  const deps = { tasks: new Map([[task.id, task], ["other", createWorkflowTask({ id: "other", script: "" })]]), getRecord: () => undefined, getCtx: () => ctx, viewAgentConversation: async () => {} };
  await showWorkflowDialog(ctx, task, deps);
  await showWorkflowsMenu(ctx, deps);
  expect(select).toHaveBeenCalledWith("Workflows", expect.arrayContaining([expect.stringContaining("wf_outcome — Execution: completed")]));
});
