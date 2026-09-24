vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import { describe, expect, it, vi } from "vitest";
import { snapshotHistory } from "../src/graph/history.js";
import { mergeGraphRuns } from "../src/graph/history-view.js";
import { renderObservabilityPaneLines, toPaneSource } from "../src/graph/pane/render.js";
import { createGraphRunTask } from "../src/graph/task.js";
import { applyPanelKey, initialPanelState, type PanelRun, renderPanelLines } from "../src/ui/observability-panel.js";

const opts = { width: 120 };
function fixture(): PanelRun {
  return { id: "run", name: "run", status: "completed", source: {
    task: { status: "completed", startTime: 0, endTime: 100 },
    meta: { name: "run", description: "description" },
    progress: [0, 1].map(index => ({ type: "workflow_agent", index: index + 10, label: "Same", state: "done", resultPreview: `output-${index}`, recordId: `record-${index}`, presentation: { kind: "agent", name: "Same" } })),
  } };
}
const text = (lines: ReturnType<typeof renderPanelLines>) => lines.map(line => line.map(segment => segment.text).join(""));
function selectSecond(run: PanelRun) {
  let state = initialPanelState();
  for (let i = 0; i < 3; i++) state = applyPanelKey([run], state, "j", opts).state;
  return state;
}

describe("Herdr panel regression seams", () => {
  it.each([12, 6, 3, 2])("keeps a selected roster row in a %i-row viewport", rows => {
    const run = fixture();
    run.source.input = { long: "input ".repeat(100) };
    const state = { ...selectSecond(run), expandedSections: ["full-inputs"] };
    const lines = text(renderPanelLines([run], state, { ...opts, rows }));
    expect(lines).toHaveLength(rows);
    expect(lines.some(line => line.includes("›") && line.includes("Same"))).toBe(true);
  });

  it("uses stable indices to select, inspect and open duplicate unbound labels", () => {
    const run = fixture();
    const state = selectSecond(run);
    expect(text(renderPanelLines([run], state, opts)).join("\n")).toContain("output-1");
    expect(applyPanelKey([run], state, "c", opts).action).toEqual({ kind: "open", recordId: "record-1" });
    run.source.progress = [...run.source.progress].reverse();
    expect(applyPanelKey([run], state, "c", opts).action).toEqual({ kind: "open", recordId: "record-1" });
    const previous = applyPanelKey([run], state, "k", opts).state;
    expect(previous.cursor).not.toEqual(state.cursor);
  });

  it("keeps the selected gutter while only the detail section uses reverse video", () => {
    const run = fixture();
    const state = applyPanelKey([run], selectSecond(run), "\r", opts).state;
    expect(state.focus).toBe("detail");
    const lines = renderObservabilityPaneLines([run], state, opts);
    expect(lines.filter(line => line.includes("›"))).toHaveLength(1);
    const highlighted = lines.filter(line => line.includes("\x1b[7m"));
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]).toContain("Outcome");
    expect(highlighted[0]).not.toContain("›");
  });

  it("navigates duplicate history labels independently without retaining private data", () => {
    const task = createGraphRunTask({ id: "history", script: "" });
    Object.assign(task, { status: "completed", endTime: 100 });
    task.graphRunProgress = [...fixture().source.progress];
    const saved = snapshotHistory(task);
    if (!saved) throw new Error("Missing history");
    expect(JSON.stringify(saved)).not.toMatch(/presentation|record-|output-/);
    const history = mergeGraphRuns([], [saved]).get(task.id);
    if (!history) throw new Error("Missing restored history");
    const run: PanelRun = { id: history.id, name: "history", status: history.status, source: toPaneSource(history) };
    const second = selectSecond(run);
    const first = applyPanelKey([run], second, "k", opts).state;
    expect(first.cursor).not.toEqual(second.cursor);
    expect(text(renderPanelLines([run], second, opts)).filter(line => /›.*Same/.test(line))).toHaveLength(1);
    expect(applyPanelKey([run], second, "c", opts).action).toBeUndefined();
  });
});
