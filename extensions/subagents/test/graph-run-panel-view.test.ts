// graph-run-panel-view.test.ts — the in-Pi host around the observability panel.
// Exercise the REAL terminal-cell layout (not the ASCII unit stub) so navigation
// and control dispatch mean what they say, mirroring observability-panel.test.ts.
vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import assert from "node:assert/strict";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { snapshotHistory } from "../src/graph/history.js";
import { mergeGraphRuns } from "../src/graph/history-view.js";
import { createGraphRunTask, type GraphRunTask } from "../src/graph/task.js";
import { GraphRunPanelView } from "../src/ui/graph-run-panel-view.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const fakeTui = () => ({ terminal: { rows: 40 }, requestRender: vi.fn() }) as unknown as TUI;

function liveTask(id: string, name: string, startTime: number): GraphRunTask {
  const task = createGraphRunTask({ id, script: "x", startTime });
  task.graphRunName = name;
  task.status = "running";
  task.agentCount = 1;
  task.graphRunProgress = [
    { type: "graph_run_agent", index: 0, label: "worker", state: "progress", recordId: `${id}-rec`, agentType: "chengfeng" },
  ];
  return task;
}

describe("GraphRunPanelView", () => {
  it("renders the shown run's name and status word", () => {
    const task = liveTask("agr_a", "alpha-run", 1000);
    const view = new GraphRunPanelView(fakeTui(), () => [task], task.id, theme, vi.fn(), {
      controls: true, detach: false, viewportPct: 70, onAction: vi.fn(),
    });
    const text = view.render(120).join("\n");
    expect(text).toContain("alpha-run");
    expect(text).toContain("RUNNING");
  });

  it("closes on esc from roster focus", () => {
    const task = liveTask("agr_a", "alpha-run", 1000);
    const done = vi.fn();
    const view = new GraphRunPanelView(fakeTui(), () => [task], task.id, theme, done, {
      controls: true, detach: false, viewportPct: 70, onAction: vi.fn(),
    });
    view.handleInput("\x1b");
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it("dispatches open for c on a node with a recordId", () => {
    const task = liveTask("agr_a", "alpha-run", 1000);
    const onAction = vi.fn();
    const view = new GraphRunPanelView(fakeTui(), () => [task], task.id, theme, vi.fn(), {
      controls: true, detach: false, viewportPct: 70, onAction,
    });
    view.handleInput("j"); // stage 0
    view.handleInput("j"); // worker node
    view.handleInput("c");
    expect(onAction).toHaveBeenCalledWith({ kind: "open", recordId: "agr_a-rec" }, task);
  });

  it("switches runs with the right arrow and retargets the next action", () => {
    const first = liveTask("agr_a", "alpha-run", 2000);
    const second = liveTask("agr_b", "beta-run", 1000);
    const onAction = vi.fn();
    const view = new GraphRunPanelView(fakeTui(), () => [first, second], first.id, theme, vi.fn(), {
      controls: true, detach: false, viewportPct: 70, onAction,
    });
    view.handleInput("\x1b[C"); // right → switch to the second run
    view.handleInput("x");
    expect(onAction).toHaveBeenLastCalledWith({ kind: "kill" }, second);
  });

  it("dispatches nothing for controls or c on a read-only history run", () => {
    const live = createGraphRunTask({ id: "hist", script: "" });
    Object.assign(live, { status: "failed", endTime: Date.now() });
    live.graphRunProgress = [{ type: "graph_run_agent", index: 0, label: "node", state: "error", recordId: "private" }];
    const snapshot = snapshotHistory(live);
    assert.ok(snapshot);
    const history = mergeGraphRuns([], [snapshot]).get("hist");
    assert.ok(history);
    const onAction = vi.fn();
    const view = new GraphRunPanelView(fakeTui(), () => [history], history.id, theme, vi.fn(), {
      controls: true, detach: false, viewportPct: 70, onAction,
    });
    expect(view.render(120).join("\n")).toContain("History snapshot");
    view.handleInput("j");
    view.handleInput("j");
    for (const key of ["p", "x", "s", "r", "c"]) view.handleInput(key);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("frames the in-Pi panel and keeps the footer under the separator", () => {
    const task = liveTask("agr_a", "alpha-run", 1000);
    const view = new GraphRunPanelView(fakeTui(), () => [task], task.id, theme, vi.fn(), {
      controls: true, detach: false, viewportPct: 70, onAction: vi.fn(),
    });
    const lines = view.render(120);
    expect(lines[0]?.startsWith("╭")).toBe(true);
    expect(lines.at(-1)?.startsWith("╰")).toBe(true);
    expect(lines.at(-3)?.startsWith("├")).toBe(true);
    expect(lines.at(-2)).toContain("close");
    view.dispose();
  });

  it("fills the frame to the exact width and restores the background after reverse video", () => {
    const bg = "\x1b[48;5;236m";
    const ansi = {
      fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[39m`,
      bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
      getBgAnsi: () => bg,
    };
    const task = liveTask("agr_a", "alpha-run", 1000);
    const view = new GraphRunPanelView(fakeTui(), () => [task], task.id, ansi, vi.fn(), {
      controls: true, detach: false, viewportPct: 70, onAction: vi.fn(),
    });
    const lines = view.render(64);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(64);
      expect(line.startsWith(bg)).toBe(true);
      expect(line.endsWith("\x1b[49m")).toBe(true);
    }
    expect(lines.some(line => line.includes(`\x1b[0m${bg}`))).toBe(true);
    expect(view.render(5).some(line => line.startsWith("╭"))).toBe(false);
    view.dispose();
  });
});
