vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

// Live-run frontier presentation: the graph panel's ∑ status line, per-node
// elapsed brackets, and frontier-first auto-fold. Tested through the pure render
// seam (renderPanelLines / applyPanelKey), asserting produced lines and next
// state — never private layout internals. Exercises the REAL terminal-cell
// layout (not the ASCII unit stub) so width-safety means what it says.

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { GraphRunAgentEntry } from "../src/graph/progress.js";
import {
  applyPanelKey,
  initialPanelState,
  type PanelRun,
  type PanelState,
  renderPanelLines,
  type Target,
} from "../src/ui/observability-panel.js";

const NOW = 200_000;

const plain = (lines: ReturnType<typeof renderPanelLines>): string[] =>
  lines.map(line => line.map(segment => segment.text).join(""));

/** The live-run fixture from the presentation spec: an in-flight bounded-feedback run. */
function liveFixture(): PanelRun {
  const progress: GraphRunAgentEntry[] = [];
  const add = (id: string, data: Partial<GraphRunAgentEntry>) =>
    progress.push({
      type: "graph_run_agent",
      state: "done",
      index: progress.length,
      label: id,
      nodeBinding: id,
      instanceId: `${id}-uuid`,
      agentType: "chengfeng",
      model: "GPT-5.6 Luna",
      ...data,
    } as GraphRunAgentEntry);
  add("research", { state: "progress", startedAt: 0, agentType: undefined, model: undefined, presentation: { kind: "bounded_feedback", name: "Research", iterations: [{ iteration: 1, decision: "continue" }] } });
  add("work-1", { label: "Gather evidence · iteration 1", agentType: undefined, model: undefined, presentation: { kind: "fanout", name: "Gather evidence", parentInstanceId: "research-uuid", iteration: 1 } });
  for (const i of [0, 1, 2, 3]) add(`work-1-${i + 1}`, { durationMs: 40_000, label: `Gather evidence · iteration 1 · item ${i + 1}`, presentation: { kind: "agent", name: `item ${i + 1}`, parentInstanceId: "work-1-uuid", iteration: 1, itemIndex: i } });
  add("eval-1", { label: "Evaluate evidence · iteration 1", agentType: "direnjie", model: "GPT-5.6 Sol", durationMs: 30_000, presentation: { kind: "agent", name: "Evaluate evidence", parentInstanceId: "research-uuid", iteration: 1 } });
  add("work-2", { state: "progress", startedAt: 150_000, label: "Gather evidence · iteration 2", agentType: undefined, model: undefined, presentation: { kind: "fanout", name: "Gather evidence", parentInstanceId: "research-uuid", iteration: 2 } });
  add("work-2-1", { durationMs: 21_000, label: "Gather evidence · iteration 2 · item 1", presentation: { kind: "agent", name: "item 1", parentInstanceId: "work-2-uuid", iteration: 2, itemIndex: 0 } });
  add("work-2-2", { state: "progress", startedAt: 179_000, label: "Gather evidence · iteration 2 · item 2", presentation: { kind: "agent", name: "item 2", parentInstanceId: "work-2-uuid", iteration: 2, itemIndex: 1 } });
  add("eval-2", { state: "start", queuedAt: 150_000, label: "Evaluate evidence · iteration 2", agentType: "direnjie", model: "GPT-5.6 Sol", presentation: { kind: "agent", name: "Evaluate evidence", parentInstanceId: "research-uuid", iteration: 2 } });
  add("synthesis", { state: "start", queuedAt: 0, agentType: "jintong", model: "GPT-5.6 Terra", deps: ["research"], presentation: { kind: "agent", name: "Synthesize context" } });
  return { id: "r1", name: "context-gather", status: "running", source: { task: { status: "running", startTime: 0 }, meta: { name: "context-gather", description: "Adaptively gather evidence with one gap-closing pass" }, progress } };
}

const liveState = (): PanelState => ({ ...initialPanelState(), cursor: { kind: "node", id: "work-2-2" } });
const ITER1: Target = { kind: "iteration", owner: "research", iteration: 1 };

const MOCK_72 = [
  " context-gather                                                  RUNNING",
  " Adaptively gather evidence with one gap-closing pass",
  " 9 agents · 3 coordination nodes · 2 iterations",
  "",
  " ▾ Graph run ───────────────────────────────────────────────────────────",
  "",
  "     ├─ ● running  Research              bounded feedback · 2 iterations",
  "     │  ├─ ↻ Iteration 1 ▸                             6 done · continue",
  "     │  └─ ↻ Iteration 2",
  "     │     ├─ ● running  Gather evidence               fanout · 2 agents",
  "     │     │  ├─ ✓ done     item 1              chengfeng · GPT-5.6 Luna",
  "   › │     │  └─ ● running  item 2 [21s]        chengfeng · GPT-5.6 Luna",
  "     │     └─ ○ queued   Evaluate evidence [50s]  direnjie · GPT-5.6 Sol",
  "     └─ ○ queued   Synthesize context [3m20s]    jintong · GPT-5.6 Terra",
  "",
  "",
  " ─ Selected node ──────────────────────────────────────────────────────",
  "",
  " Gather evidence · iteration 2 · item 2",
  " Running · agent · chengfeng · GPT-5.6 Luna · 21s",
  "",
  " Flow",
  "   Gather evidence · iteration 2",
  "      └─ this agent",
  "",
  "",
  "",
  "",
  " ∑ ● 3 running · ○ 2 queued · ✓ 7 done                             3m20s",
  " ↑↓ select · Enter expand · Space fold · f filter · Esc close",
];

const MOCK_44 = [
  " context-gather                      RUNNING",
  " Adaptively gather evidence with one",
  "gap-closing pass",
  " 9 agents · 3 coordination nodes · 2 iterat…",
  "",
  " ▾ Graph run ───────────────────────────────",
  "",
  "     ├─ ● running  Research",
  "     │  ├─ ↻ Iteration 1 ▸          continue",
  "     │  └─ ↻ Iteration 2",
  "     │     ├─ ● running  Gather evidence",
  "     │     │  ├─ ✓ done     item 1",
  "   › │     │  └─ ● running  item 2 [21s]    ",
  "     │     └─ ○ queued   Evaluate evidence",
  "     └─ ○ queued   Synthesize context",
  "",
  "",
  " ─ Selected node ──────────────────────────",
  "",
  " Gather evidence · iteration 2 · item 2",
  " Running · agent · chengfeng · GPT-5.6 Luna…",
  "",
  " Flow",
  "   Gather evidence · iteration 2",
  "      └─ this agent",
  "",
  "",
  "",
  " ∑ 3 running · 2 queued · 7 done       3m20s",
  " ↑↓ select · Enter expand · Space fold · f …",
];

describe("S1 live-run frontier mock parity", () => {
  it("renders the exact accepted 72×30 live-frontier mock", () => {
    const lines = plain(renderPanelLines([liveFixture()], liveState(), { width: 72, rows: 30, now: NOW }));
    expect(lines).toEqual(MOCK_72);
  });
  it("renders the exact accepted 44×30 live-frontier mock", () => {
    const lines = plain(renderPanelLines([liveFixture()], liveState(), { width: 44, rows: 30, now: NOW }));
    expect(lines).toEqual(MOCK_44);
  });
  it("puts the ∑ status line second-to-last and drops the old range/node-count hints", () => {
    const lines = plain(renderPanelLines([liveFixture()], liveState(), { width: 72, rows: 30, now: NOW }));
    expect(lines.at(-2)).toContain("∑");
    expect(lines.join("\n")).not.toMatch(/\d+-\d+\/\d+/);
    expect(lines.join("\n")).not.toMatch(/\d+\/\d+ nodes/);
  });
});

describe("S2 bracket rules and paused lifecycle", () => {
  it("brackets only running/queued agent rows and never coordination rows or waiting", () => {
    const rows = plain(renderPanelLines([liveFixture()], liveState(), { width: 72, rows: 30, now: NOW }));
    const roster = rows.slice(0, rows.findIndex(line => line.includes("Selected node")));
    for (const line of roster) {
      if (/✓ done/.test(line)) expect(line).not.toContain("[");
      if (/Research|Gather evidence/.test(line)) expect(line).not.toContain("[");
      expect(line).not.toContain("waiting");
    }
  });
  it("reflects a paused run in brackets and the ∑ line", () => {
    const run = liveFixture();
    run.status = "paused";
    run.source.task.pausedAt = 190_000;
    const lines = plain(renderPanelLines([run], liveState(), { width: 72, rows: 30, now: NOW }));
    const joined = lines.join("\n");
    expect(joined).toContain("Ⅱ paused");
    expect(joined).toContain("item 2 [11s]");
    expect(joined).toContain("Evaluate evidence [40s]");
    expect(lines.at(-2)).toContain("Ⅱ 3 paused");
    expect(lines.at(-2)?.trimEnd().endsWith("3m10s")).toBe(true);
  });
});

describe("S3 width safety and degradation", () => {
  it("keeps every line within width and never truncates a bracket, across widths and modes", () => {
    for (const width of [0, 1, 2, 8, 20, 40, 44, 72, 120]) {
      for (const ascii of [false, true]) {
        for (const rows of [undefined, 30] as const) {
          const lines = plain(renderPanelLines([liveFixture()], liveState(), { width, rows, ascii, now: NOW }));
          for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(width);
            expect(line).not.toMatch(/\[[^\]]*…/);
          }
        }
      }
    }
  });
  it("degrades the ∑ line to ASCII without the ∑ glyph", () => {
    const lines = plain(renderPanelLines([liveFixture()], liveState(), { width: 72, rows: 30, ascii: true, now: NOW }));
    expect(lines.at(-2)).not.toContain("∑");
    expect(lines.at(-2)).toContain("* 3 running · o 2 queued · + 7 done");
  });
});

describe("S4 auto-fold guards", () => {
  const foldedIteration1 = (run: PanelRun, state: PanelState, opts: Parameters<typeof renderPanelLines>[2]): boolean => {
    const roster = plain(renderPanelLines([run], state, opts));
    const iterLine = roster.find(line => line.includes("Iteration 1"));
    return !!iterLine && iterLine.includes("▸");
  };
  it("does not auto-fold a completed run", () => {
    const run = liveFixture();
    run.status = "completed";
    run.source.task.status = "completed";
    run.source.task.endTime = 200_000;
    expect(foldedIteration1(run, liveState(), { width: 72, rows: 30, now: NOW })).toBe(false);
  });
  it("does not auto-fold when rows is undefined", () => {
    expect(foldedIteration1(liveFixture(), liveState(), { width: 72, now: NOW })).toBe(false);
  });
  it("does not auto-fold when the height is generous", () => {
    expect(foldedIteration1(liveFixture(), liveState(), { width: 72, rows: 60, now: NOW })).toBe(false);
  });
  it("does not auto-fold an iteration with a failed descendant", () => {
    const run = liveFixture();
    const work13 = run.source.progress[4];
    if (work13.type !== "graph_run_agent") throw new Error("fixture");
    work13.state = "error";
    expect(foldedIteration1(run, liveState(), { width: 72, rows: 30, now: NOW })).toBe(false);
  });
  it("does not auto-fold an iteration the cursor is inside", () => {
    const state: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "work-1-2" } };
    expect(foldedIteration1(liveFixture(), state, { width: 72, rows: 30, now: NOW })).toBe(false);
  });
  it("does auto-fold an iteration the cursor sits on", () => {
    const state: PanelState = { ...initialPanelState(), cursor: ITER1 };
    expect(foldedIteration1(liveFixture(), state, { width: 72, rows: 18, now: NOW })).toBe(true);
  });
});

describe("S5 user toggle wins over auto-fold", () => {
  const opts = { width: 72, rows: 30, now: NOW };
  it("Space expands an auto-folded iteration and keeps it expanded on re-render", () => {
    const state: PanelState = { ...initialPanelState(), cursor: ITER1 };
    const foldOpts = { width: 72, rows: 18, now: NOW };
    const first = applyPanelKey([liveFixture()], state, " ", foldOpts);
    const joined = plain(first.lines).join("\n");
    expect(joined).toContain("item 1");
    const iterRow = plain(first.lines).find(line => line.includes("Iteration 1"));
    expect(iterRow).not.toContain("▸");
    expect(first.state.expandedTargets).toEqual([ITER1]);
    const rerendered = plain(renderPanelLines([liveFixture()], first.state, foldOpts));
    expect(rerendered.find(line => line.includes("Iteration 1"))).not.toContain("▸");
    const second = applyPanelKey([liveFixture()], first.state, " ", foldOpts);
    expect(second.state.collapsedTargets).toContainEqual(ITER1);
    expect(second.state.expandedTargets).not.toContainEqual(ITER1);
  });
  it("navigates from the auto-folded iteration row to the next iteration", () => {
    const state: PanelState = { ...initialPanelState(), cursor: ITER1 };
    const next = applyPanelKey([liveFixture()], state, "\x1b[B", { width: 72, rows: 18, now: NOW });
    expect(next.state.cursor).toEqual({ kind: "iteration", owner: "research", iteration: 2 });
  });
  it("keeps auto-fold stable when the cursor moves between node and structural rows", () => {
    const iterationRow = (lines: string[]) => lines.find(line => line.includes("Iteration 1"));
    const onNode = plain(renderPanelLines([liveFixture()], liveState(), opts));
    const onIteration2: PanelState = { ...initialPanelState(), cursor: { kind: "iteration", owner: "research", iteration: 2 } };
    const onStructure = plain(renderPanelLines([liveFixture()], onIteration2, opts));
    expect(iterationRow(onNode)).toContain("▸");
    expect(iterationRow(onStructure)).toContain("▸");
    const up = applyPanelKey([liveFixture()], onIteration2, "\x1b[A", opts);
    expect(up.state.cursor).toEqual(ITER1);
  });
  it("resets expandedTargets on a run switch", () => {
    const runs = [liveFixture(), { ...liveFixture(), id: "r2", name: "second" }];
    const start: PanelState = { ...liveState(), expandedTargets: [ITER1] };
    const next = applyPanelKey(runs, start, "\x1b[C", opts);
    expect(next.state.expandedTargets).toEqual([]);
  });
});

describe("S6 ∑ ordering, degradation, and small heights", () => {
  function mixedRun(status: PanelRun["status"] = "running"): PanelRun {
    const progress: GraphRunAgentEntry[] = [];
    const add = (id: string, data: Partial<GraphRunAgentEntry>) =>
      progress.push({ type: "graph_run_agent", state: "start", index: progress.length, label: id, nodeBinding: id, instanceId: `${id}-uuid`, presentation: { kind: "agent", name: id }, ...data } as GraphRunAgentEntry);
    add("failed", { state: "error" });
    add("blocked", { state: "error", blocked: true });
    add("skipped", { state: "error", skipped: true });
    add("running", { state: "progress", startedAt: 0 });
    add("queued", { state: "start", queuedAt: 0 });
    add("done", { state: "done" });
    return { id: "m", name: "mixed", status, source: { task: { status: status === "killed" ? "killed" : "running", startTime: 0 }, meta: { name: "mixed" }, progress } };
  }
  it("orders ∑ segments authoritatively and omits zero categories", () => {
    const lines = plain(renderPanelLines([mixedRun()], initialPanelState(), { width: 120, rows: 30, now: NOW }));
    expect(lines.at(-2)).toContain("× 1 failed · ! 1 blocked · ● 1 running · ○ 1 queued · ✓ 1 done · – 1 skipped");
  });
  it("reports stopped entries on a killed run", () => {
    const run = mixedRun("killed");
    const unfinished = run.source.progress[3];
    if (unfinished.type !== "graph_run_agent") throw new Error("fixture");
    const lines = plain(renderPanelLines([run], initialPanelState(), { width: 120, rows: 30, now: NOW }));
    expect(lines.at(-2)).toContain("■ 2 stopped");
  });
  it("keeps the footer at rows 1, a content row at rows 2, and ∑ only from rows 3", () => {
    const one = renderPanelLines([mixedRun()], initialPanelState(), { width: 72, rows: 1, now: NOW });
    expect(one).toHaveLength(1);
    expect(one[0].map(s => s.text).join("")).toContain("select");
    const two = plain(renderPanelLines([mixedRun()], initialPanelState(), { width: 72, rows: 2, now: NOW }));
    expect(two).toHaveLength(2);
    expect(two[0]).not.toContain("∑");
    expect(two[1]).toContain("select");
    const three = plain(renderPanelLines([mixedRun()], initialPanelState(), { width: 72, rows: 3, now: NOW }));
    expect(three).toHaveLength(3);
    expect(three[0]).not.toContain("∑");
    expect(three[1]).toContain("∑");
    expect(three[2]).toContain("select");
  });
});
