vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import { describe, expect, it, vi } from "vitest";
import type { WorkflowAgentEntry } from "../src/graph/progress.js";
import { initialPanelState, type PanelRun, renderPanelLines } from "../src/ui/observability-panel.js";

function agent(over: Partial<WorkflowAgentEntry> & Pick<WorkflowAgentEntry, "index" | "label">): WorkflowAgentEntry {
  return { type: "workflow_agent", state: "done", ...over };
}

function fixture(): PanelRun {
  const progress: WorkflowAgentEntry[] = [];
  const add = (id: string, data: Partial<WorkflowAgentEntry>) => progress.push(agent({
    index: progress.length,
    label: id,
    nodeBinding: id,
    instanceId: `${id}-uuid`,
    ...data,
  }));

  add("research", { presentation: { kind: "bounded_feedback", name: "Research", iterations: [{ iteration: 1, decision: "continue" }, { iteration: 2, decision: "sufficient" }] } });
  add("work-1", { label: "Gather evidence · iteration 1", presentation: { kind: "fanout", name: "Gather evidence", parentInstanceId: "research-uuid", iteration: 1, role: "work" } });
  add("work-1-1", { label: "Gather evidence · iteration 1 · item 1", presentation: { kind: "agent", name: "item 1", parentInstanceId: "work-1-uuid", iteration: 1, itemIndex: 0, role: "item" } });
  add("work-1-2", { label: "Gather evidence · iteration 1 · item 2", presentation: { kind: "agent", name: "item 2", parentInstanceId: "work-1-uuid", iteration: 1, itemIndex: 1, role: "item" } });
  add("eval-1", { label: "Evaluate evidence · iteration 1", presentation: { kind: "agent", name: "Evaluate evidence", parentInstanceId: "research-uuid", iteration: 1, role: "evaluator" } });
  add("work-2", { label: "Gather evidence · iteration 2", presentation: { kind: "fanout", name: "Gather evidence", parentInstanceId: "research-uuid", iteration: 2, role: "work" } });
  add("work-2-1", { label: "Gather evidence · iteration 2 · item 1", presentation: { kind: "agent", name: "item 1", parentInstanceId: "work-2-uuid", iteration: 2, itemIndex: 0, role: "item" } });
  add("eval-2", { label: "Evaluate evidence · iteration 2", presentation: { kind: "agent", name: "Evaluate evidence", parentInstanceId: "research-uuid", iteration: 2, role: "evaluator" } });
  add("synthesis", { presentation: { kind: "agent", name: "Synthesize context" } });

  return {
    id: "compact-roster",
    name: "context-gather",
    status: "completed",
    source: {
      task: { status: "completed", startTime: 0, endTime: 100 },
      meta: { name: "context-gather", description: "Gather context" },
      progress,
    },
  };
}

const text = (lines: ReturnType<typeof renderPanelLines>): string[] => lines.map(line => line.map(segment => segment.text).join(""));
const nodeRow = (line: string): boolean => /✓ done|↻ Iteration/.test(line);

describe("Herdr compact roster", () => {
  it("renders bounded feedback tree rows contiguously while preserving section gaps and short-pane selection", () => {
    const state = { ...initialPanelState(), cursor: { kind: "node" as const, id: "work-1-2" } };
    const full = text(renderPanelLines([fixture()], state, { width: 120 }));
    const workflow = full.findIndex(line => line.includes("Workflow"));
    const selectedNode = full.findIndex(line => line.includes("Selected node"));
    const roster = full.slice(workflow + 2, selectedNode);

    expect(full[workflow + 1]).toBe("");
    expect(full.slice(selectedNode - 2, selectedNode)).toEqual(["", ""]);
    expect(roster.filter(line => /^[\s│]+$/.test(line))).toEqual([]);

    const short = text(renderPanelLines([fixture()], state, { width: 120, rows: 6 }));
    expect(short.filter(nodeRow)).toHaveLength(3);
    expect(short.find(line => line.includes("›") && line.includes("item 2"))).toBeDefined();
  });
});
