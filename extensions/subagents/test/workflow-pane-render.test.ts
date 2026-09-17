// workflow-pane-render.test.ts (S1) — the Herdr side-pane renderer reuses the
// real `layoutWorkflowDialog`, so the pane can never drift from the in-Pi
// overlay. Exercise the REAL terminal-cell layout (not the ASCII unit stub) so
// the width-safety assertion means what it says.
vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { initialWorkflowDialogState, type WorkflowDialogSource } from "../src/ui/workflow-dialog.js";
import { applyPaneKey, PANE_ANSI_THEME, renderWorkflowPaneLines, toPaneSource } from "../src/workflow/pane/render.js";
import { createWorkflowTask } from "../src/workflow/task.js";

const NOW = 1_700_000_000_000;

function source(): WorkflowDialogSource {
  return {
    progress: [
      { type: "workflow_phase", index: 0, title: "Discover" },
      { type: "workflow_phase", index: 1, title: "Review" },
      {
        type: "workflow_agent",
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
        type: "workflow_agent",
        index: 1,
        label: "review-auth",
        phaseIndex: 1,
        phaseTitle: "Review",
        state: "progress",
        agentType: "reviewer",
        model: "haiku 4.5",
      },
      {
        type: "workflow_agent",
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
    task: { status: "running", workflowName: "audit", startTime: NOW - 60_000 },
    meta: { name: "audit", description: "Audit the codebase", phases: [{ title: "Discover" }, { title: "Review" }] },
    agentCount: 3,
  };
}

describe("renderWorkflowPaneLines", () => {
  it("renders the overview with the workflow name, a phase title, and an agent label", () => {
    const lines = renderWorkflowPaneLines(source(), { width: 60, now: NOW });
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join("\n");
    expect(joined).toContain("audit");
    expect(joined).toContain("Discover");
    // The overview's right pane lists the selected (first) phase's agents.
    expect(joined).toContain("discover-auth");
  });

  it("keeps every rendered line within the requested width", () => {
    const width = 60;
    const lines = renderWorkflowPaneLines(source(), { width, now: NOW });
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("emits ANSI colour via the pane theme", () => {
    const lines = renderWorkflowPaneLines(source(), { width: 60, now: NOW });
    // At least one styled segment carries a real SGR escape.
    expect(lines.some(line => line.includes("\x1b["))).toBe(true);
    // The theme maps the 7 card colours plus bold.
    expect(PANE_ANSI_THEME.fg("success", "x")).toContain("\x1b[");
    expect(PANE_ANSI_THEME.bold("x")).toContain("\x1b[1m");
    // An unknown colour passes through untouched rather than emitting garbage.
    expect(PANE_ANSI_THEME.fg("not-a-color", "plain")).toBe("plain");
  });

  it("builds the exact source shape the overlay reads from a task", () => {
    const task = createWorkflowTask({ id: "wf_1", script: "x", meta: { name: "audit", description: "d" } });
    task.workflowName = "audit";
    task.agentCount = 4;
    const src = toPaneSource(task);
    expect(src.task.status).toBe(task.status);
    expect(src.task.workflowName).toBe("audit");
    expect(src.task.startTime).toBe(task.startTime);
    expect(src.progress).toBe(task.workflowProgress);
    expect(src.meta).toBe(task.meta);
    expect(src.agentCount).toBe(4);
  });
});

describe("applyPaneKey — read-only in-pane navigation", () => {
  it("moves the phase selection on a down key", () => {
    const start = initialWorkflowDialogState();
    const { state } = applyPaneKey(source(), start, "j", { width: 60, now: NOW });
    expect(state.selectedPhase).toBe(1);
  });

  it("opens the selected phase into the agent level on enter", () => {
    const start = initialWorkflowDialogState();
    const { state } = applyPaneKey(source(), start, "\r", { width: 60, now: NOW });
    expect(state.level).toBe("agent");
  });

  it("leaves state unchanged for a key that is not the dialog's", () => {
    const start = initialWorkflowDialogState();
    const { state } = applyPaneKey(source(), start, "z", { width: 60, now: NOW });
    expect(state).toBe(start);
  });

  it("never advertises mutating actions in the footer (footer honesty)", () => {
    const joined = renderWorkflowPaneLines(source(), { width: 60, now: NOW }).join("\n");
    expect(joined).toContain("select");
    for (const forbidden of ["pause", "stop", "convo", "skip", "retry"]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it("still suppresses mutating hints after navigating into the agent level", () => {
    const start = initialWorkflowDialogState();
    const { lines } = applyPaneKey(source(), start, "\r", { width: 60, now: NOW });
    const joined = lines.join("\n");
    for (const forbidden of ["pause", "stop", "convo", "skip", "retry"]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it("renders from an explicitly supplied view state", () => {
    const overview = renderWorkflowPaneLines(source(), { width: 60, now: NOW }).join("\n");
    const atAgent = renderWorkflowPaneLines(source(), {
      width: 60,
      now: NOW,
      state: { ...initialWorkflowDialogState(), level: "agent" },
    }).join("\n");
    expect(atAgent).not.toBe(overview);
  });

  it("reports close=true for esc at the overview level", () => {
    const { close } = applyPaneKey(source(), initialWorkflowDialogState(), "\x1b", { width: 60, now: NOW });
    expect(close).toBe(true);
  });

  it("treats esc at the detail level as back, not close", () => {
    const start = initialWorkflowDialogState();
    const drilled = applyPaneKey(source(), start, "\r", { width: 60, now: NOW });
    expect(drilled.state.level).toBe("agent");
    const backed = applyPaneKey(source(), drilled.state, "\x1b", { width: 60, now: NOW });
    expect(backed.close).toBe(false);
    expect(backed.state.level).toBe("phases");
  });

  it("never reports close for a navigation key", () => {
    const { close } = applyPaneKey(source(), initialWorkflowDialogState(), "j", { width: 60, now: NOW });
    expect(close).toBe(false);
  });
});
