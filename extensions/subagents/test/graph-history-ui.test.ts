vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { snapshotHistory } from "../src/graph/history.js";
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

  it("renders the same read-only disclosure and generic failed detail on both surfaces", () => {
    const history = required(mergeWorkflowRuns([], [snapshot]).get("same"));
    const source = toPaneSource(history);
    const state = initialWorkflowDialogState();
    const input = { ...source, state, width: 140 };
    const dialog = layoutWorkflowDialog(input).flat().map(segment => segment.text).join("\n");
    const runs = [{ id: history.id, name: "history", status: history.status, source }];
    const panelState = { ...initialPanelState(), cursor: { kind: "node" as const, id: "failed-node" } };
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
