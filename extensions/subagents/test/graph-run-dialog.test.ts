// Exercise real terminal-cell wrapping rather than the unit harness's ASCII stub.
vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import assert from "node:assert/strict";
import type * as codingAgent from "@earendil-works/pi-coding-agent";
import { type OverlayHandle, stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphRunAgentEntry, GraphRunEntry } from "../src/graph/progress.js";
import { createGraphRunTask } from "../src/graph/task.js";
import type { AgentRecord } from "../src/types.js";
import {
  GraphRunDialog,
  graphRunAgentModel,
  handleGraphRunDialogKey,
  initialGraphRunDialogState,
  layoutGraphRunDialog,
  plainGraphRunDialogLines,
  resolveGraphRunDialog,
  subStatusAnnotations,
} from "../src/ui/graph-run-dialog.js";
import { showGraphRunDialog, showGraphRunsMenu } from "../src/ui/graph-run-menu.js";

const theme = { fg: (_: string, text: string) => `\x1b[36m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
const widths = [0, 1, 2, 8, 20, 40, 80, 120];
const agent: GraphRunAgentEntry = {
  type: "workflow_agent", index: 7, label: "child", state: "progress", recordId: "child-id",
  agentType: "chengfeng", model: "haiku,gpt-5.6-luna,qwen", modelId: "gpt-5.6-luna", thinking: "off",
};
const source = () => ({ task: { status: "running" as const, startTime: 100 }, progress: [agent] });
const text = (input: Parameters<typeof layoutGraphRunDialog>[0]) => plainGraphRunDialogLines(layoutGraphRunDialog(input)).join("\n");
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
    expect(graphRunAgentModel(queued, "queued")).toBe("model pending");
    expect(graphRunAgentModel(unresolved, "running")).toBe("model pending");
    expect(graphRunAgentModel(agent, "running")).toBe("gpt-5.6-luna");
    const rendered = text({ ...source(), progress: [queued, agent], state: initialGraphRunDialogState(), width: 120 });
    expect(rendered).toContain("model pending");
    expect(rendered).toContain("gpt-5.6-luna");
    expect(rendered).not.toContain("haiku,gpt-5.6-luna,qwen");
    expect(rendered).not.toContain("asked");
  });

  it("keeps one phase-grouped roster and explicit lifecycle words", () => {
    const progress: GraphRunEntry[] = [
      { type: "workflow_phase", index: 0, title: "Research" },
      { ...agent, index: 0, label: "running", phaseIndex: 0, phaseTitle: "Research" },
      { ...agent, index: 1, label: "queued", state: "start", queuedAt: 10, phaseIndex: 0, phaseTitle: "Research", modelId: undefined },
      { type: "workflow_phase", index: 1, title: "Verify" },
      { ...agent, index: 2, label: "finished", state: "done", phaseIndex: 1, phaseTitle: "Verify" },
    ];
    const rendered = text({
      task: { status: "running", startTime: 100 }, progress,
      meta: { name: "audit", description: "", phases: [{ title: "Research" }, { title: "Verify" }, { title: "Report" }] },
      state: initialGraphRunDialogState(), width: 120,
    });
    for (const marker of ["Research", "Verify", "Report", "Running", "Queued", "Completed", "Waiting for the graph to schedule"]) {
      expect(rendered).toContain(marker);
    }
  });

  it("shows dynamic round titles and orders attempt before its reason", () => {
    const progress: GraphRunAgentEntry[] = [
      { ...agent, index: 8, label: "r1", phaseIndex: 0, phaseTitle: "Round 1/2", attempt: 2, lastAttemptReason: "user-retry" },
      { ...agent, index: 9, label: "r2", phaseIndex: 1, phaseTitle: "Round 2/2", attempt: 3, lastAttemptReason: "loop" },
    ];
    const rendered = text({
      task: { status: "running", startTime: 100 }, progress,
      state: initialGraphRunDialogState(), width: 120,
    });
    expect(rendered).toContain("Round 1/2");
    expect(rendered).toContain("Round 2/2");
    expect(subStatusAnnotations(progress[0], "running", 100)).toEqual(["attempt 2", "user retry"]);
    expect(subStatusAnnotations(progress[1], "running", 100)).toEqual(["attempt 3", "loop"]);
    const userRetryRow = rendered.split("\n").find(line => line.includes("r1") && line.includes("gpt-5.6-luna"));
    const loopRow = rendered.split("\n").find(line => line.includes("r2") && line.includes("gpt-5.6-luna"));
    expect(userRetryRow).toContain("r1 · attempt");
    expect(userRetryRow).toContain("gpt-5.6-luna");
    expect(loopRow).toContain("r2 · attempt");
    expect(loopRow).toContain("gpt-5.6-luna");
  });

  it("renders every terminal distinction and paused scheduling semantics explicitly", () => {
    const progress: GraphRunAgentEntry[] = [
      { ...agent, index: 0, label: "failed", state: "error", error: "failed" },
      { ...agent, index: 1, label: "blocked", state: "error", blocked: true, error: "blocked" },
      { ...agent, index: 2, label: "skipped", state: "error", skipped: true },
      { ...agent, index: 3, label: "stopped", state: "progress" },
      { ...agent, index: 4, label: "replayed", state: "done", cached: true, modelId: undefined },
    ];
    const rendered = text({ task: { status: "completed", startTime: 100 }, progress, state: initialGraphRunDialogState(), width: 120 });
    for (const marker of ["Failed", "Blocked", "Skipped", "Stopped", "Replayed", "model not run"]) expect(rendered).toContain(marker);
    const queued = { ...agent, index: 5, label: "queued", state: "start" as const, queuedAt: 10, modelId: undefined };
    const paused = text({ task: { status: "paused", startTime: 100 }, progress: [queued], state: initialGraphRunDialogState(5), width: 120 });
    expect(paused).toContain("Execution: paused");
    expect(paused).toContain("no new agents start");
  });

  it("preserves selection by stable entry index as progress grows", () => {
    const chosen = { ...agent, index: 12, label: "chosen" };
    const state = initialGraphRunDialogState(12);
    const before = resolveGraphRunDialog({ ...source(), progress: [chosen], state, width: 120 });
    const after = resolveGraphRunDialog({ ...source(), progress: [{ ...agent, index: 4 }, chosen, { ...agent, index: 20 }], state, width: 120 });
    expect(before.selectedEntry?.label).toBe("chosen");
    expect(after.selectedEntry?.label).toBe("chosen");
    expect(handleGraphRunDialogKey("j", state, after)?.state.selectedIndex).toBe(20);
  });
});

describe("workflow inspector interaction", () => {
  it("routes controls through stable entry and record ids", () => {
    const state = initialGraphRunDialogState(7);
    const view = resolveGraphRunDialog({ ...source(), state, width: 120 });
    for (const [key, action] of [["x", { kind: "kill" }], ["p", { kind: "pause" }], ["s", { kind: "skip", index: 7 }], ["r", { kind: "retry", index: 7 }], ["c", { kind: "open", recordId: "child-id" }]] as const) {
      expect(handleGraphRunDialogKey(key, state, view)?.action).toEqual(action);
    }
    const paused = resolveGraphRunDialog({ ...source(), task: { status: "paused", startTime: 100 }, state, width: 120 });
    expect(handleGraphRunDialogKey("p", state, paused)?.action).toEqual({ kind: "resume" });
  });

  it("uses side-by-side detail when wide and explicit drill-in/back when narrow", () => {
    const state = initialGraphRunDialogState(7);
    const wide = resolveGraphRunDialog({ ...source(), state, width: 120 });
    expect(wide.narrow).toBe(false);
    expect(text({ ...source(), state, width: 120 })).toContain("Current activity");
    const narrow = resolveGraphRunDialog({ ...source(), state, width: 40 });
    expect(narrow.narrow).toBe(true);
    const opened = handleGraphRunDialogKey("\r", state, narrow);
    assert.ok(opened);
    expect(opened.state.level).toBe("detail");
    expect(text({ ...source(), state: opened.state, width: 40 })).toContain("Current activity");
    expect(handleGraphRunDialogKey("\x1b", opened.state, resolveGraphRunDialog({ ...source(), state: opened.state, width: 40 }))?.state.level).toBe("roster");
  });

  it("puts terminal outcome before prompt and exposes contextual controls on demand", () => {
    const state = initialGraphRunDialogState(7);
    const progress = [{ ...agent, state: "done" as const, resultPreview: "outcome-marker", promptPreview: "prompt-marker" }];
    const collapsed = text({ task: { status: "completed", startTime: 100 }, progress, state, width: 120 });
    expect(collapsed.indexOf("outcome-marker")).toBeLessThan(collapsed.indexOf("prompt-marker"));
    expect(collapsed).not.toContain("x stop");
    const help = handleGraphRunDialogKey("?", state, resolveGraphRunDialog({ task: { status: "running", startTime: 100 }, progress: [agent], state, width: 120 }));
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
    const dialog = new GraphRunDialog({ requestRender, terminal: { rows: 40 } } as unknown as TUI, () => ({ task, progress: [agent] }), theme, vi.fn());
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
  const task = createGraphRunTask({ id: "wf_test", script: "" });
  task.graphRunProgress = [agent];
  let dialog: GraphRunDialog | undefined;
  let finishViewer: (() => void) | undefined;
  const setHidden = vi.fn();
  const custom: codingAgent.ExtensionContext["ui"]["custom"] = (factory, options) => new Promise((resolve, reject) => {
    void Promise.resolve(factory({ requestRender() {} } as TUI, theme as codingAgent.Theme, {} as codingAgent.KeybindingsManager, resolve)).then(component => {
      assert.ok(component instanceof GraphRunDialog);
      dialog = component;
      assert.ok(options?.onHandle);
      options.onHandle({ setHidden } as unknown as OverlayHandle);
    }).then(undefined, reject);
  });
  const ui: Pick<codingAgent.ExtensionContext["ui"], "notify" | "custom"> = { notify: vi.fn(), custom };
  const ctx = { ui: ui as codingAgent.ExtensionContext["ui"] };
  const record = { id: "child-id" } as AgentRecord;
  const viewAgentConversation = vi.fn(() => new Promise<void>(resolve => { finishViewer = resolve; }));
  const opened = showGraphRunDialog(ctx, task, { tasks: new Map([[task.id, task]]), getRecord: () => record, getCtx: () => ctx, viewAgentConversation });
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
  const task = createGraphRunTask({ id: "wf_outcome", script: "" });
  task.status = "completed";
  task.outcome = { status: "failed", reason: "verification failed" };
  task.value = { retained: "evidence" };
  const custom: codingAgent.ExtensionContext["ui"]["custom"] = factory => new Promise((resolve, reject) => {
    void Promise.resolve(factory({ requestRender() {} } as TUI, theme as codingAgent.Theme, {} as codingAgent.KeybindingsManager, resolve)).then(component => {
      assert.ok(component instanceof GraphRunDialog);
      expect(stripTerminalSequences(component.render(120).join("\n"))).toContain("Outcome: failed — verification failed");
      component.handleInput("\x1b");
    }).then(undefined, reject);
  });
  const select = vi.fn(async () => undefined);
  const ui = { custom, select, notify: vi.fn() } as unknown as codingAgent.ExtensionContext["ui"];
  const ctx = { ui };
  const deps = { tasks: new Map([[task.id, task], ["other", createGraphRunTask({ id: "other", script: "" })]]), getRecord: () => undefined, getCtx: () => ctx, viewAgentConversation: async () => {} };
  await showGraphRunDialog(ctx, task, deps);
  await showGraphRunsMenu(ctx, deps);
  expect(select).toHaveBeenCalledWith("Graph runs", expect.arrayContaining([expect.stringContaining("wf_outcome — Execution: completed")]));
});
