// graph-run-pane-render.test.ts (S1) — the Herdr side-pane renderer reuses the
// real `layoutGraphRunDialog`, so the pane can never drift from the in-Pi
// overlay. Exercise the REAL terminal-cell layout (not the ASCII unit stub) so
// the width-safety assertion means what it says.
vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { applyPaneKey, PANE_ANSI_THEME, renderGraphRunPaneLines, toPaneSource } from "../src/graph/pane/render.js";
import { createGraphRunTask } from "../src/graph/task.js";
import { type GraphRunDialogSource, initialGraphRunDialogState } from "../src/ui/graph-run-dialog.js";

const NOW = 1_700_000_000_000;

function source(): GraphRunDialogSource {
  return {
    progress: [
      { type: "graph_run_phase", index: 0, title: "Discover" },
      { type: "graph_run_phase", index: 1, title: "Review" },
      {
        type: "graph_run_agent",
        index: 0,
        label: "discover-auth",
        phaseIndex: 0,
        phaseTitle: "Discover",
        state: "done",
        agentType: "explorer",
        tokens: 1200,
        toolCalls: 3,
        durationMs: 4200,
      },
      {
        type: "graph_run_agent",
        index: 1,
        label: "review-auth",
        phaseIndex: 1,
        phaseTitle: "Review",
        state: "progress",
        agentType: "reviewer",
        model: "haiku 4.5",
      },
      {
        type: "graph_run_agent",
        index: 2,
        label: "review-net",
        phaseIndex: 1,
        phaseTitle: "Review",
        state: "done",
        tokens: 800,
        toolCalls: 1,
        durationMs: 2000,
      },
    ],
    task: { status: "running", graphRunName: "audit", startTime: NOW - 60_000 },
    meta: { name: "audit", description: "Audit the codebase", phases: [{ title: "Discover" }, { title: "Review" }] },
    agentCount: 3,
  };
}

describe("renderGraphRunPaneLines", () => {
  it("renders the overview with the graph run name, a phase title, and an agent label", () => {
    const lines = renderGraphRunPaneLines(source(), { width: 60, now: NOW });
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join("\n");
    expect(joined).toContain("audit");
    expect(joined).toContain("Discover");
    // The overview's right pane lists the selected (first) phase's agents.
    expect(joined).toContain("discover-auth");
  });

  it("keeps every rendered line within the requested width", () => {
    const width = 60;
    const lines = renderGraphRunPaneLines(source(), { width, now: NOW });
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("emits ANSI colour via the pane theme", () => {
    const lines = renderGraphRunPaneLines(source(), { width: 60, now: NOW });
    // At least one styled segment carries a real SGR escape.
    expect(lines.some(line => line.includes("\x1b["))).toBe(true);
    // The theme maps the 7 card colours plus bold.
    expect(PANE_ANSI_THEME.fg("success", "x")).toContain("\x1b[");
    expect(PANE_ANSI_THEME.bold("x")).toContain("\x1b[1m");
    // An unknown colour passes through untouched rather than emitting garbage.
    expect(PANE_ANSI_THEME.fg("not-a-color", "plain")).toBe("plain");
  });

  it("builds the exact source shape the overlay reads from a task", () => {
    const task = createGraphRunTask({ id: "agr_1", script: "x", meta: { name: "audit", description: "d" } });
    task.graphRunName = "audit";
    task.agentCount = 4;
    const src = toPaneSource(task);
    expect(src.task.status).toBe(task.status);
    expect(src.task.graphRunName).toBe("audit");
    expect(src.task.startTime).toBe(task.startTime);
    expect(src.progress).toBe(task.graphRunProgress);
    expect(src.meta).toBe(task.meta);
    expect(src.agentCount).toBe(4);
  });
});

describe("applyPaneKey — read-only in-pane navigation", () => {
  it("moves the node selection on a down key", () => {
    const start = initialGraphRunDialogState();
    const { state } = applyPaneKey(source(), start, "j", { width: 60, now: NOW });
    expect(state.selectedIndex).toBe(1);
  });

  it("opens the selected node into the detail level on enter", () => {
    const start = initialGraphRunDialogState();
    const { state } = applyPaneKey(source(), start, "\r", { width: 60, now: NOW });
    expect(state.level).toBe("detail");
  });

  it("leaves state unchanged for a key that is not the dialog's", () => {
    const start = initialGraphRunDialogState();
    const { state } = applyPaneKey(source(), start, "z", { width: 60, now: NOW });
    expect(state).toBe(start);
  });

  it("never advertises mutating actions in the footer (footer honesty)", () => {
    const joined = renderGraphRunPaneLines(source(), { width: 60, now: NOW }).join("\n");
    expect(joined).toContain("select");
    for (const forbidden of ["pause", "stop", "convo", "skip", "retry"]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it("still suppresses mutating hints after navigating into the detail level", () => {
    const start = initialGraphRunDialogState();
    const { lines } = applyPaneKey(source(), start, "\r", { width: 60, now: NOW });
    const joined = lines.join("\n");
    for (const forbidden of ["pause", "stop", "convo", "skip", "retry"]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it("renders from an explicitly supplied view state", () => {
    const overview = renderGraphRunPaneLines(source(), { width: 60, now: NOW }).join("\n");
    const atDetail = renderGraphRunPaneLines(source(), {
      width: 60,
      now: NOW,
      state: { ...initialGraphRunDialogState(), level: "detail" },
    }).join("\n");
    expect(atDetail).not.toBe(overview);
  });

  it("reports close=true for esc at the overview level", () => {
    const { close } = applyPaneKey(source(), initialGraphRunDialogState(), "\x1b", { width: 60, now: NOW });
    expect(close).toBe(true);
  });

  it("treats esc at the detail level as back, not close", () => {
    const start = initialGraphRunDialogState();
    const drilled = applyPaneKey(source(), start, "\r", { width: 60, now: NOW });
    expect(drilled.state.level).toBe("detail");
    const backed = applyPaneKey(source(), drilled.state, "\x1b", { width: 60, now: NOW });
    expect(backed.close).toBe(false);
    expect(backed.state.level).toBe("roster");
  });

  it("never reports close for a navigation key", () => {
    const { close } = applyPaneKey(source(), initialGraphRunDialogState(), "j", { width: 60, now: NOW });
    expect(close).toBe(false);
  });
});

it("keeps the centered/fallback inspector unchanged when Herdr presentation metadata is added", () => {
  const input = source();
  const before = renderGraphRunPaneLines(input, { width: 120, now: NOW });
  input.progress = input.progress.map(entry => entry.type === "graph_run_agent" ? { ...entry, presentation: { kind: "agent" as const, name: "Herdr-only name", iteration: 9 } } : entry);
  expect(renderGraphRunPaneLines(input, { width: 120, now: NOW })).toEqual(before);
  const nav = applyPaneKey(input, initialGraphRunDialogState(), "\r", { width: 120, now: NOW });
  expect(nav).toEqual(applyPaneKey(source(), initialGraphRunDialogState(), "\r", { width: 120, now: NOW }));
  expect(nav.lines.join("\n")).not.toContain("Herdr-only name");
});
