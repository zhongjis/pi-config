// observability-panel.test.ts — the /graph-runs pane's default view. Pure and
// terminal-free, tested through the one seam (renderPanelLines / applyPanelKey),
// asserting on produced lines and next state, never on private layout internals.
// Exercise the REAL terminal-cell layout (not the ASCII unit stub) so the
// width-safety assertion means what it says, mirroring workflow-pane-render.test.ts.
vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { renderObservabilityPaneLines } from "../src/graph/pane/render.js";
import type { WorkflowAgentEntry, WorkflowEntry, WorkflowRunStatus } from "../src/graph/progress.js";
import { coerceGraphInput } from "../src/graph/run-graph.js";
import {
  applyPanelKey,
  initialPanelState,
  type PanelRun,
  type PanelState,
  renderPanelLines,
} from "../src/ui/observability-panel.js";

const NOW = 1_700_000_000_000;

function agent(over: Partial<WorkflowAgentEntry> & Pick<WorkflowAgentEntry, "index" | "label">): WorkflowAgentEntry {
  return { type: "workflow_agent", state: "start", ...over };
}

// A four-node DAG: a → {b, c} → d, laid out across three topological stages.
const graphProgress: WorkflowEntry[] = [
  agent({ index: 0, label: "a", phaseIndex: 0, phaseTitle: "Stage 1", state: "done", agentType: "explorer", model: "haiku 4.5", deps: [], dependents: ["b", "c"], startedAt: NOW - 50_000, durationMs: 4_000, resultPreview: "found the seam" }),
  agent({ index: 1, label: "b", phaseIndex: 1, phaseTitle: "Stage 2", state: "progress", agentType: "reviewer", model: "sonnet", deps: ["a"], dependents: ["d"], startedAt: NOW - 10_000, toolCalls: 3 }),
  agent({ index: 2, label: "c", phaseIndex: 1, phaseTitle: "Stage 2", state: "start", agentType: "reviewer", deps: ["a"], dependents: ["d"], queuedAt: NOW - 20_000 }),
  agent({ index: 3, label: "d", phaseIndex: 2, phaseTitle: "Stage 3", state: "error", agentType: "verifier", deps: ["b", "c"], dependents: [], error: "boom" }),
];

function graphRun(status: WorkflowRunStatus = "running"): PanelRun {
  return {
    id: "wf_a",
    name: "graph-x",
    status,
    source: { progress: graphProgress, task: { status, workflowName: "graph-x", startTime: NOW - 60_000 }, agentCount: 4 },
  };
}

function otherRun(): PanelRun {
  const progress: WorkflowEntry[] = [
    agent({ index: 0, label: "seed", phaseIndex: 0, phaseTitle: "Stage 1", state: "done", deps: [], dependents: [] }),
  ];
  return {
    id: "wf_b",
    name: "graph-y",
    status: "completed",
    source: { progress, task: { status: "completed", workflowName: "graph-y", startTime: NOW - 120_000, endTime: NOW - 90_000 }, agentCount: 1 },
  };
}

const plain = (lines: ReturnType<typeof renderPanelLines>): string[] =>
  lines.map(line => line.map(segment => segment.text).join(""));
const text = (runs: PanelRun[], state: PanelState, opts: Parameters<typeof renderPanelLines>[2]) =>
  plain(renderPanelLines(runs, state, opts)).join("\n");

describe("observability panel — rendering", () => {
  it("lays out nodes by topological stage in dependency order", () => {
    const rendered = text([graphRun()], initialPanelState(), { width: 60, now: NOW });
    for (const marker of ["Stage 1", "Stage 2", "Stage 3", "graph-x"]) expect(rendered).toContain(marker);
    // Stage 1 precedes Stage 2 precedes Stage 3 (dependency order, top to bottom).
    expect(rendered.indexOf("Stage 1")).toBeLessThan(rendered.indexOf("Stage 2"));
    expect(rendered.indexOf("Stage 2")).toBeLessThan(rendered.indexOf("Stage 3"));
    // Each node sits under its stage rollup.
    for (const node of ["a", "b", "c", "d"]) expect(rendered).toContain(node);
  });

  it("counts live states in the summary strip", () => {
    const rendered = text([graphRun()], initialPanelState(), { width: 80, now: NOW });
    expect(rendered).toContain("running 1");
    expect(rendered).toContain("queued 1");
    expect(rendered).toContain("done 1");
    expect(rendered).toContain("failed 1");
  });

  it("shows static graph glyphs, agent type, model, and live activity in roster rows", () => {
    const rendered = text([graphRun()], initialPanelState(), { width: 120, now: NOW });
    const running = rendered.split("\n").find(line => line.includes("running") && line.includes("b"));
    expect(running).toContain("*");
    expect(running).toContain("reviewer");
    expect(running).toContain("sonnet");
    expect(running).toContain("3 tools");
    expect(rendered).toContain("+ a  done");
  });

  it("shows inherited round titles and distinct retry reasons", () => {
    const progress: WorkflowAgentEntry[] = [
      agent({ index: 4, label: "round-1:item:0", phaseIndex: 0, phaseTitle: "Round 1/2", state: "progress", attempt: 2, lastAttemptReason: "user-retry", startedAt: NOW - 2_000 }),
      agent({ index: 5, label: "round-2:item:0", phaseIndex: 1, phaseTitle: "Round 2/2", state: "progress", attempt: 3, lastAttemptReason: "loop", startedAt: NOW - 1_000 }),
    ];
    const run: PanelRun = {
      id: "wf_rounds", name: "rounds", status: "running",
      source: { progress, task: { status: "running", startTime: NOW - 5_000 }, agentCount: 2 },
    };
    const rendered = text([run], initialPanelState(), { width: 120, now: NOW });
    expect(rendered).toContain("Round 1/2");
    expect(rendered).toContain("Round 2/2");
    expect(rendered).toContain("attempt 2 · user retry");
    expect(rendered).toContain("attempt 3 · loop");
    for (const line of plain(renderPanelLines([run], initialPanelState(), { width: 20, now: NOW }))) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
  });

  it("shows live graph context below the run header and expands full inputs with e", () => {
    const run = graphRun();
    (run.source as typeof run.source & { input?: unknown }).input = coerceGraphInput('{"task":"Map the repository","extra":{"json":true}}');
    run.source.meta = {
      name: "graph-x",
      description: "Gather repository context before implementation.",
      inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
    };
    const collapsed = text([run], initialPanelState(), { width: 100, now: NOW });
    expect(collapsed).toContain("Description");
    expect(collapsed).toContain("Gather repository context before implementation.");
    expect(collapsed).toContain("task: Map the repository");
    expect(collapsed).toContain("Full inputs · e expand");
    const expanded = applyPanelKey([run], initialPanelState(), "e", { width: 100, now: NOW });
    expect(collapsed).not.toContain("extra");
    const expandedText = plain(expanded.lines).join("\n");
    expect(expandedText).toContain("extra:");
    expect(expandedText).toContain("json");
    expect(expandedText).not.toContain('"extra": {');
  });

  it("shows scalar live input before Full inputs", () => {
    const run = graphRun();
    (run.source as typeof run.source & { input?: unknown }).input = "Map the repository";
    const rendered = text([run], initialPanelState(), { width: 100, now: NOW });
    expect(rendered.indexOf("Input: Map the repository")).toBeLessThan(rendered.indexOf("Full inputs"));
  });

  it("joins upstream dependency state for the selected node (always-on detail)", () => {
    const rendered = text([graphRun()], { ...initialPanelState(), cursor: { kind: "node", id: "d" } }, { width: 60, now: NOW });
    expect(rendered).toContain("Waits on (upstream)");
    // d waits on b (running) and c (queued); each dep is shown with its live state.
    const detail = rendered.slice(rendered.indexOf("Waits on (upstream)"));
    expect(detail).toMatch(/b\s+running/);
    expect(detail).toMatch(/\* b\s+running/);
    expect(detail).toMatch(/c\s+queued/);
  });

  it("lists downstream nodes the selection unblocks", () => {
    const rendered = text([graphRun()], { ...initialPanelState(), cursor: { kind: "node", id: "a" } }, { width: 60, now: NOW });
    expect(rendered).toContain("Unblocks (downstream)");
    expect(rendered).toContain("→ b → c");
    // A leaf node gates nothing.
    const leaf = text([graphRun()], { ...initialPanelState(), cursor: { kind: "node", id: "d" } }, { width: 60, now: NOW });
    expect(leaf.slice(leaf.indexOf("Unblocks (downstream)"))).toContain("—");
  });

  it("shows a failed node's error in its detail", () => {
    const rendered = text([graphRun()], { ...initialPanelState(), cursor: { kind: "node", id: "d" } }, { width: 60, now: NOW });
    expect(rendered).toContain("boom");
  });

  it("renders the run switcher with status, position, and other-run chips", () => {
    const runs = [graphRun(), otherRun()];
    const rendered = text(runs, initialPanelState(), { width: 70, now: NOW });
    expect(rendered).toContain("graph-x");
    expect(rendered).toContain("1/2");
    // The other run appears as a health chip.
    expect(rendered).toContain("graph-y");
  });

  it("uses one switcher row when no other run chips exist", () => {
    const lines = plain(renderPanelLines([graphRun()], initialPanelState(), { width: 70, now: NOW }));
    expect(lines[1]).toContain("1/4");
  });

  it("caps expanded full inputs with an overflow hint while retaining the footer", () => {
    const run = graphRun();
    (run.source as typeof run.source & { input?: unknown }).input = { task: "x".repeat(100), extra: Array.from({ length: 20 }, () => "value") };
    run.source.meta = {
      name: "graph-x",
      description: "Inspect inputs.",
      inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
    };
    const lines = plain(renderPanelLines(
      [run],
      { ...initialPanelState(), expandedSections: ["full-inputs"] },
      { width: 20, rows: 12, now: NOW },
    ));
    expect(lines).toHaveLength(12);
    expect(lines.join("\n")).toContain("task:");
    expect(lines.join("\n")).toMatch(/…\d+ more/);
    expect(lines.at(-1)).toContain("live");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
  });

  it("fills exactly the requested pane height", () => {
    const states: PanelState[] = [
      initialPanelState(),
      { ...initialPanelState(), cursor: { kind: "node", id: "d" }, focus: "detail", expandedSections: ["outcome"] },
      { ...initialPanelState(), cursor: { kind: "node", id: "a" }, focus: "detail", expandedSections: ["outcome"] },
    ];
    for (const rows of [12, 24, 40]) {
      for (const state of states) {
        // Both zones (roster + divider + capped detail) still fill the height exactly.
        expect(renderPanelLines([graphRun()], state, { width: 50, rows, now: NOW }).length).toBe(rows);
      }
    }
  });

  it("keeps every rendered line within the requested width", () => {
    const states: PanelState[] = [
      initialPanelState(),
      { ...initialPanelState(), cursor: { kind: "node", id: "d" }, focus: "detail" },
      { ...initialPanelState(), cursor: { kind: "node", id: "a" }, focus: "detail", expandedSections: ["outcome"] },
    ];
    for (const width of [10, 20, 40, 60, 80, 120]) {
      for (const rows of [undefined, 24]) {
        for (const state of states) {
          const lines = plain(renderPanelLines([graphRun(), otherRun()], state, { width, rows, now: NOW }));
          for (const line of lines) {
            expect(stripTerminalSequences(line)).not.toMatch(/[\r\n]/);
            expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          }
        }
      }
    }
  });

  it("renders an ASCII tier free of box-drawing and unicode glyphs", () => {
    const rendered = text([graphRun(), otherRun()], { ...initialPanelState(), cursor: { kind: "node", id: "a" } }, { width: 60, ascii: true, now: NOW });
    expect(rendered).toContain("Stage 1");
    expect(rendered).toContain("-> b -> c");
    for (const glyph of ["─", "‹", "›", "●", "○", "↑", "↓", "←", "→", "✔", "✘", "◌", "❯", "⏎"]) {
      expect(rendered).not.toContain(glyph);
    }
  });
});

describe("observability panel — no-run and single-node edge cases", () => {
  it("shows the empty state when there are no runs", () => {
    const rendered = text([], initialPanelState(), { width: 40, now: NOW });
    expect(rendered).toContain("No graph runs in this session yet.");
  });

  it("fills the height even with no runs", () => {
    const lines = renderPanelLines([], initialPanelState(), { width: 40, rows: 20, now: NOW });
    expect(lines.length).toBe(20);
  });

  it("renders a single-node run without a throw", () => {
    const single: PanelRun = {
      id: "wf_s",
      name: "solo",
      status: "completed",
      source: { progress: [agent({ index: 0, label: "only", phaseIndex: 0, state: "done", deps: [], dependents: [] })], task: { status: "completed", startTime: NOW - 1_000 }, agentCount: 1 },
    };
    const rendered = text([single], { ...initialPanelState(), cursor: { kind: "node", id: "only" } }, { width: 50, now: NOW });
    expect(rendered).toContain("Stage 1");
    expect(rendered).toContain("only");
    expect(rendered).toContain("entry node");
  });
});

describe("observability panel — keys", () => {
  const opts = { width: 60, now: NOW } as const;

  it("moves the cursor with j/k over the interleaved target order from an unset cursor", () => {
    const down = applyPanelKey([graphRun()], initialPanelState(), "j", opts);
    expect(down.state.cursor).toEqual({ kind: "stage", stage: 0 });
    expect(down.close).toBe(false);
    const down2 = applyPanelKey([graphRun()], down.state, "j", opts);
    expect(down2.state.cursor).toEqual({ kind: "node", id: "a" });
    const up = applyPanelKey([graphRun()], down2.state, "k", opts);
    expect(up.state.cursor).toEqual({ kind: "stage", stage: 0 });
  });

  it("stays at the first target on up from an unset cursor", () => {
    const up = applyPanelKey([graphRun()], initialPanelState(), "k", opts);
    expect(up.state.cursor).toEqual({ kind: "stage", stage: 0 });
  });

  it("clamps the cursor at the target-list ends", () => {
    const first = applyPanelKey([graphRun()], { ...initialPanelState(), cursor: { kind: "stage", stage: 0 } }, "k", opts);
    expect(first.state.cursor).toEqual({ kind: "stage", stage: 0 });
    const last = applyPanelKey([graphRun()], { ...initialPanelState(), cursor: { kind: "node", id: "d" } }, "j", opts);
    expect(last.state.cursor).toEqual({ kind: "node", id: "d" });
  });

  it("resets the detail cursor when the roster cursor moves", () => {
    const start: PanelState = { ...initialPanelState(), cursor: { kind: "stage", stage: 0 }, detailCursor: 3 };
    const down = applyPanelKey([graphRun()], start, "j", opts);
    expect(down.state.detailCursor).toBe(0);
  });

  it("scrolls the roster with pageDown/pageUp, clamped at zero", () => {
    const down = applyPanelKey([graphRun()], initialPanelState(), "\x1b[6~", opts);
    expect(down.state.scroll).toBe(5);
    const up = applyPanelKey([graphRun()], down.state, "\x1b[5~", opts);
    expect(up.state.scroll).toBe(0);
    const stay = applyPanelKey([graphRun()], up.state, "\x1b[5~", opts);
    expect(stay.state.scroll).toBe(0);
  });

  it("switches runs with ←/→, resetting the cursor and scroll", () => {
    const runs = [graphRun(), otherRun()];
    const start: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "d" }, scroll: 4 };
    const right = applyPanelKey(runs, start, "\x1b[C", opts);
    expect(right.state.runIndex).toBe(1);
    expect(right.state.cursor).toBeUndefined();
    expect(right.state.scroll).toBe(0);
    expect(right.state.focus).toBe("roster");
    // The switcher now points at the second run.
    expect(plain(right.lines).join("\n")).toContain("graph-y");
    const left = applyPanelKey(runs, right.state, "\x1b[D", opts);
    expect(left.state.runIndex).toBe(0);
    // Left at the first run is a clamped no-op.
    const clamped = applyPanelKey(runs, initialPanelState(), "\x1b[D", opts);
    expect(clamped.state.runIndex).toBe(0);
  });

  it("closes on esc/q and ignores keys it does not own", () => {
    expect(applyPanelKey([graphRun()], initialPanelState(), "\x1b", opts).close).toBe(true);
    expect(applyPanelKey([graphRun()], initialPanelState(), "q", opts).close).toBe(true);
    expect(applyPanelKey([graphRun()], initialPanelState(), "j", opts).close).toBe(false);
    const start = initialPanelState();
    const unowned = applyPanelKey([graphRun()], start, "z", opts);
    expect(unowned.state).toBe(start);
    expect(unowned.close).toBe(false);
  });

  it("still closes on esc with no runs and ignores navigation", () => {
    expect(applyPanelKey([], initialPanelState(), "\x1b", opts).close).toBe(true);
    const nav = applyPanelKey([], initialPanelState(), "j", opts);
    expect(nav.close).toBe(false);
  });
});

describe("observability panel — two-level focus (v3)", () => {
  const opts = { width: 60, now: NOW } as const;

  // A node with BOTH a Prompt and an Outcome, i.e. two navigable detail sections.
  const bothRun = (over: Partial<WorkflowAgentEntry> = {}, status: WorkflowRunStatus = "completed"): PanelRun => ({
    id: "wf_both",
    name: "both",
    status,
    source: {
      progress: [agent({ index: 0, label: "solo", phaseIndex: 0, state: "done", deps: [], dependents: [], promptPreview: "investigate the auth flow ".repeat(10).trim(), resultPreview: "found the seam ".repeat(20).trim(), ...over })],
      task: { status, workflowName: "both", startTime: NOW - 5_000 },
      agentCount: 1,
    },
  });

  it("enters the detail on a node with an expandable section with enter", () => {
    // Node a has a resultPreview → one navigable (Outcome) section.
    const state: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "a" }, collapsedStages: [1] };
    const r = applyPanelKey([graphRun()], state, "\r", opts);
    expect(r.state.focus).toBe("detail");
    expect(r.state.detailCursor).toBe(0);
    expect(r.state.cursor).toEqual({ kind: "node", id: "a" });
    // enter no longer folds: the collapse set is untouched.
    expect(r.state.collapsedStages).toEqual([1]);
    expect(r.close).toBe(false);
  });

  it("is a no-op on enter for a running node with no prompt/outcome", () => {
    // Node b is running with no promptPreview/resultPreview → no navigable section.
    const state: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "b" } };
    const r = applyPanelKey([graphRun()], state, "\r", opts);
    expect(r.state.focus).toBe("roster");
    expect(r.close).toBe(false);
  });

  it("folds and reopens a stage cursor with enter", () => {
    const state: PanelState = { ...initialPanelState(), cursor: { kind: "stage", stage: 1 } };
    const folded = applyPanelKey([graphRun()], state, "\r", opts);
    expect(folded.state.collapsedStages).toContain(1);
    const reopened = applyPanelKey([graphRun()], folded.state, "\r", opts);
    expect(reopened.state.collapsedStages).not.toContain(1);
  });

  it("moves the detail cursor over the navigable sections with ↑↓, clamped at the ends", () => {
    const start: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "solo" }, focus: "detail" };
    const d1 = applyPanelKey([bothRun()], start, "j", opts); // Prompt → Outcome
    expect(d1.state.detailCursor).toBe(1);
    const d2 = applyPanelKey([bothRun()], d1.state, "j", opts); // clamps at Outcome
    expect(d2.state.detailCursor).toBe(1);
    const u1 = applyPanelKey([bothRun()], d2.state, "k", opts); // Outcome → Prompt
    expect(u1.state.detailCursor).toBe(0);
    const u2 = applyPanelKey([bothRun()], u1.state, "k", opts); // clamps at Prompt
    expect(u2.state.detailCursor).toBe(0);
  });

  it("toggles a section's expansion with enter/space, growing then shrinking it", () => {
    // The focused section's label is a padded reverse-video bar, so match by substring.
    const bodyUnder = (lines: string[], label: string): number => {
      const idx = lines.findIndex(line => line.includes(label));
      let n = 0;
      for (let i = idx + 1; i < lines.length && lines[i].startsWith("    "); i++) n++;
      return n;
    };
    const wide = { width: 80, now: NOW } as const;
    const start: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "solo" }, focus: "detail", detailCursor: 0 };
    const collapsed = bodyUnder(plain(renderPanelLines([bothRun()], start, wide)), "Prompt");
    expect(collapsed).toBeLessThanOrEqual(2);

    const expanded = applyPanelKey([bothRun()], start, "\r", wide);
    expect(expanded.state.expandedSections).toContain("prompt");
    const expandedBody = bodyUnder(plain(expanded.lines), "Prompt");
    expect(expandedBody).toBeGreaterThan(collapsed);

    // space is the same toggle; a second press collapses it back.
    const recollapsed = applyPanelKey([bothRun()], expanded.state, " ", wide);
    expect(recollapsed.state.expandedSections).not.toContain("prompt");
    expect(bodyUnder(plain(recollapsed.lines), "Prompt")).toBe(collapsed);
  });

  it("backs out of the detail to the roster on esc without closing, then closes from the roster", () => {
    const detail: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "a" }, focus: "detail" };
    const back = applyPanelKey([graphRun()], detail, "\x1b", opts);
    expect(back.state.focus).toBe("roster");
    expect(back.close).toBe(false);
    // From the roster, esc closes (the existing top-level contract).
    expect(applyPanelKey([graphRun()], back.state, "\x1b", opts).close).toBe(true);
  });

  it("scrolls the detail zone with pageDown/pageUp in detail focus, leaving roster scroll alone", () => {
    const detail: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "a" }, focus: "detail" };
    const down = applyPanelKey([graphRun()], detail, "\x1b[6~", opts);
    expect(down.state.detailScroll).toBe(5);
    expect(down.state.scroll).toBe(0);
    const up = applyPanelKey([graphRun()], down.state, "\x1b[5~", opts);
    expect(up.state.detailScroll).toBe(0);
  });

  it("moves the reverse-video bar onto the focused detail section while the detail owns focus", () => {
    const width = 60;
    const detail: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "solo" }, focus: "detail", detailCursor: 0 };
    const lines = renderObservabilityPaneLines([bothRun()], detail, { width, now: NOW });
    const reversed = lines.filter(line => line.includes("\x1b[7m"));
    // Exactly one reverse bar, and it sits on the Prompt label (not a roster row).
    expect(reversed.length).toBe(1);
    expect(stripTerminalSequences(reversed[0])).toContain("Prompt");
  });
});

describe("observability panel — auto-fit stage-complete roster (fix #2)", () => {
  it("keeps every stage header visible on a short pane while the detail is present", () => {
    const rendered = text([graphRun()], initialPanelState(), { width: 60, rows: 14, now: NOW });
    for (const header of ["Stage 1", "Stage 2", "Stage 3"]) expect(rendered).toContain(header);
    // The detail zone still renders below the roster (the default cursor's stage aggregate).
    expect(rendered).toContain("Tokens:");
  });

  it("expands every stage's nodes when the full roster fits", () => {
    const rendered = text([graphRun()], initialPanelState(), { width: 60, rows: 40, now: NOW });
    for (const header of ["▾ Stage 1", "▾ Stage 2", "▾ Stage 3"]) expect(rendered).toContain(header);
    expect(rendered).not.toContain("▸");
  });

  it("shows only the focused stage's nodes when the full roster does not fit, moving with the cursor", () => {
    const onStage2 = text([graphRun()], { ...initialPanelState(), cursor: { kind: "stage", stage: 1 } }, { width: 60, rows: 16, now: NOW });
    expect(onStage2).toContain("▾ Stage 2");
    expect(onStage2).toContain("▸ Stage 1");
    expect(onStage2).toContain("▸ Stage 3");
    expect(onStage2).toMatch(/b\s+running/);

    // Focusing another stage moves the expansion to it.
    const onStage3 = text([graphRun()], { ...initialPanelState(), cursor: { kind: "stage", stage: 2 } }, { width: 60, rows: 16, now: NOW });
    expect(onStage3).toContain("▾ Stage 3");
    expect(onStage3).toContain("▸ Stage 2");
    expect(onStage3).toContain("▸ Stage 1");
  });
});

describe("observability panel — v1.5 filter, collapse, blast radius", () => {
  const opts = { width: 60, now: NOW } as const;

  it("cycles the roster filter all → running → failed → all with f", () => {
    const r1 = applyPanelKey([graphRun()], initialPanelState(), "f", opts);
    expect(r1.state.filter).toBe("running");
    const r2 = applyPanelKey([graphRun()], r1.state, "f", opts);
    expect(r2.state.filter).toBe("failed");
    const r3 = applyPanelKey([graphRun()], r2.state, "f", opts);
    expect(r3.state.filter).toBe("all");
  });

  it("filters the roster to matching nodes, dropping empty stages but keeping true rollups", () => {
    const running = text([graphRun()], { ...initialPanelState(), filter: "running" }, { width: 120, now: NOW });
    // Only the stage with a running node (b, in Stage 2) survives; its neighbours drop out.
    expect(running).toContain("Stage 2");
    expect(running).not.toContain("Stage 1");
    expect(running).not.toContain("Stage 3");
    // The rollup stays the TRUE total (b running + c queued), not the one filtered row.
    expect(running).toContain("0/2");
    // The summary strip surfaces the active filter; the live counts stay unfiltered.
    expect(running).toContain("filter: running");
    expect(running).toContain("queued 1");
  });

  it("snaps the cursor to the first target when a filter hides it", () => {
    // Cursor on the done node "a", then filter to running — "a" is no longer a target.
    const r = applyPanelKey([graphRun()], { ...initialPanelState(), cursor: { kind: "node", id: "a" } }, "f", opts);
    expect(r.state.filter).toBe("running");
    expect(r.state.cursor).toEqual({ kind: "stage", stage: 1 });
  });

  it("navigates over the filtered target order only", () => {
    const failed: PanelState = { ...initialPanelState(), filter: "failed" };
    // Under the failed filter only Stage 3 (d) survives → targets [stage 2 header, node d].
    const j1 = applyPanelKey([graphRun()], failed, "j", opts);
    expect(j1.state.cursor).toEqual({ kind: "stage", stage: 2 });
    const j2 = applyPanelKey([graphRun()], j1.state, "j", opts);
    expect(j2.state.cursor).toEqual({ kind: "node", id: "d" });
    const j3 = applyPanelKey([graphRun()], j2.state, "j", opts);
    expect(j3.state.cursor).toEqual({ kind: "node", id: "d" }); // clamps at the last target
  });

  it("collapses the cursor's node stage with space: hides its rows, flips ▾ to ▸, lands on the header", () => {
    const base: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "b" } };
    const dims = { width: 70, now: NOW } as const;
    const expanded = plain(renderPanelLines([graphRun()], base, dims)).join("\n");
    expect(expanded).toContain("▾ Stage 2");
    expect(expanded).toMatch(/c\s+queued/); // c's row shows while its stage is expanded
    const toggled = applyPanelKey([graphRun()], base, " ", dims);
    expect(toggled.state.collapsedStages).toContain(1);
    // Collapsing lands the cursor on the now-folded stage header, not a hidden node; focus stays roster.
    expect(toggled.state.cursor).toEqual({ kind: "stage", stage: 1 });
    expect(toggled.state.focus).toBe("roster");
    const roster = plain(toggled.lines).join("\n");
    expect(roster).toContain("▸ Stage 2");
    expect(roster).not.toContain("▾ Stage 2");
    expect(roster).not.toMatch(/c\s+queued/); // c's roster row is hidden under the collapsed stage
    // space (the fold key in roster focus) toggles the same fold back open.
    const reopened = applyPanelKey([graphRun()], toggled.state, " ", dims);
    expect(reopened.state.collapsedStages).not.toContain(1);
    expect(plain(reopened.lines).join("\n")).toMatch(/c\s+queued/);
  });

  it("keeps a collapsed stage's header in the nav order instead of skipping it", () => {
    // Stage 2 (b, c) is folded; from node a, ↓ lands on the collapsed header, not straight to d.
    const collapsed: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "a" }, collapsedStages: [1] };
    const down = applyPanelKey([graphRun()], collapsed, "j", opts);
    expect(down.state.cursor).toEqual({ kind: "stage", stage: 1 });
    const down2 = applyPanelKey([graphRun()], down.state, "j", opts);
    expect(down2.state.cursor).toEqual({ kind: "stage", stage: 2 });
    const down3 = applyPanelKey([graphRun()], down2.state, "j", opts);
    expect(down3.state.cursor).toEqual({ kind: "node", id: "d" });
  });

  it("resets collapse but keeps the filter across a run switch", () => {
    const runs = [graphRun(), otherRun()];
    const start: PanelState = { ...initialPanelState(), filter: "failed", collapsedStages: [1], cursor: { kind: "node", id: "d" }, scroll: 3 };
    const right = applyPanelKey(runs, start, "\x1b[C", opts);
    expect(right.state.runIndex).toBe(1);
    expect(right.state.filter).toBe("failed");
    expect(right.state.collapsedStages).toEqual([]);
    expect(right.state.cursor).toBeUndefined();
    expect(right.state.scroll).toBe(0);
  });

  it("shows the transitive blast radius of a failed node", () => {
    // A fails → B skipped (depends on A) → C skipped (depends on B): the skip cascades.
    const progress: WorkflowEntry[] = [
      agent({ index: 0, label: "A", phaseIndex: 0, state: "error", deps: [], dependents: ["B"], error: "kaboom" }),
      agent({ index: 1, label: "B", phaseIndex: 1, state: "error", skipped: true, deps: ["A"], dependents: ["C"] }),
      agent({ index: 2, label: "C", phaseIndex: 2, state: "error", skipped: true, deps: ["B"], dependents: [] }),
    ];
    const run: PanelRun = {
      id: "wf_bl",
      name: "blast",
      status: "failed",
      source: { progress, task: { status: "failed", workflowName: "blast", startTime: NOW - 1_000 }, agentCount: 3 },
    };
    const rendered = text([run], { ...initialPanelState(), cursor: { kind: "node", id: "A" } }, { width: 70, now: NOW });
    expect(rendered).toContain("Blast radius: B, C");
  });

  it("shows 'none yet' blast radius for a failed leaf with no skipped downstream", () => {
    const rendered = text([graphRun()], { ...initialPanelState(), cursor: { kind: "node", id: "d" } }, { width: 60, now: NOW });
    expect(rendered).toContain("Blast radius: none yet");
  });

  it("renders ASCII collapse indicators and the filter/fold hints", () => {
    // Wide enough that the full footer hint escapes clamping (narrow widths truncate it, per v1).
    const rendered = text([graphRun()], { ...initialPanelState(), collapsedStages: [1] }, { width: 120, ascii: true, now: NOW });
    expect(rendered).toContain("v Stage 1"); // expanded, ASCII tier
    expect(rendered).toContain("> Stage 2"); // collapsed, ASCII tier
    expect(rendered).toContain("f filter");
    expect(rendered).toContain("space fold");
    for (const glyph of ["▾", "▸"]) expect(rendered).not.toContain(glyph);
  });

  it("keeps every line within width with filter, collapse, and blast radius active", () => {
    const state: PanelState = { ...initialPanelState(), filter: "failed", cursor: { kind: "node", id: "d" }, collapsedStages: [0] };
    for (const width of [10, 20, 40, 60, 80, 120]) {
      for (const ascii of [false, true]) {
        const lines = plain(renderPanelLines([graphRun(), otherRun()], state, { width, ascii, now: NOW }));
        for (const line of lines) {
          expect(stripTerminalSequences(line)).not.toMatch(/[\r\n]/);
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });
});

describe("observability panel — Wave A cursor, collapse un-trap, stage detail, highlight", () => {
  const opts = { width: 60, now: NOW } as const;

  it("keeps a collapsed stage's header navigable so it can be re-expanded (un-trap)", () => {
    // Cursor on Stage 2 (b, c); space collapses it.
    const start: PanelState = { ...initialPanelState(), cursor: { kind: "stage", stage: 1 } };
    const collapsed = applyPanelKey([graphRun()], start, " ", opts);
    expect(collapsed.state.collapsedStages).toContain(1);
    // The cursor stays on the header — never stranded on a now-hidden node.
    expect(collapsed.state.cursor).toEqual({ kind: "stage", stage: 1 });
    // The stage's rows are hidden from the roster while collapsed.
    expect(plain(collapsed.lines).join("\n")).not.toMatch(/c\s+queued/);
    // space on the still-navigable header re-expands it; its nodes reappear.
    const reopened = applyPanelKey([graphRun()], collapsed.state, " ", opts);
    expect(reopened.state.collapsedStages).not.toContain(1);
    expect(plain(reopened.lines).join("\n")).toMatch(/c\s+queued/);
  });

  it("moves the cursor to the stage header when collapsing from a node, not stranding it", () => {
    const start: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "b" } };
    const collapsed = applyPanelKey([graphRun()], start, " ", opts);
    expect(collapsed.state.collapsedStages).toContain(1);
    expect(collapsed.state.cursor).toEqual({ kind: "stage", stage: 1 });
    const reopened = applyPanelKey([graphRun()], collapsed.state, " ", opts);
    expect(reopened.state.collapsedStages).not.toContain(1);
  });

  it("walks stage headers and nodes interleaved with ↓, not node-only", () => {
    // graphProgress: stage0[a], stage1[b,c], stage2[d].
    const expected: PanelState["cursor"][] = [
      { kind: "stage", stage: 0 },
      { kind: "node", id: "a" },
      { kind: "stage", stage: 1 },
      { kind: "node", id: "b" },
      { kind: "node", id: "c" },
      { kind: "stage", stage: 2 },
      { kind: "node", id: "d" },
    ];
    let state = initialPanelState();
    const seen: PanelState["cursor"][] = [];
    for (let i = 0; i < expected.length; i++) {
      state = applyPanelKey([graphRun()], state, "j", opts).state;
      seen.push(state.cursor);
    }
    expect(seen).toEqual(expected);
    // Clamps at the last target and retraces the order on the way up.
    expect(applyPanelKey([graphRun()], state, "j", opts).state.cursor).toEqual({ kind: "node", id: "d" });
    expect(applyPanelKey([graphRun()], state, "k", opts).state.cursor).toEqual({ kind: "stage", stage: 2 });
  });

  it("renders the selected row as a full-width reverse-video bar via the pane theme", () => {
    const width = 60;
    const state: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "b" } };
    const lines = renderObservabilityPaneLines([graphRun()], state, { width, now: NOW });
    const reversed = lines.filter(line => line.includes("\x1b[7m"));
    expect(reversed.length).toBe(1);
    // The inverted run spans the whole pane width.
    expect(visibleWidth(reversed[0])).toBe(width);
    expect(stripTerminalSequences(reversed[0])).toContain("b");
  });

  it("shows stage aggregates in the detail zone without repeating the per-node roster rows", () => {
    const state: PanelState = { ...initialPanelState(), cursor: { kind: "stage", stage: 1 } };
    const lines = plain(renderPanelLines([graphRun()], state, { width: 70, now: NOW }));
    const detailStart = lines.findIndex(line => line.includes("Stage ── 2"));
    expect(detailStart).toBeGreaterThan(-1);
    const detail = lines.slice(detailStart).join("\n");
    // Aggregate counts across the stage (b running + c queued), plus a rolled-up facts line.
    expect(detail).toContain("running 1");
    expect(detail).toContain("queued 1");
    expect(detail).toContain("Tokens:");
    expect(detail).toContain("Tools:");
    // The aggregate never repeats the per-node glyph rows the roster already shows.
    expect(detail).not.toMatch(/b\s+running/);
    expect(detail).not.toMatch(/c\s+queued/);
  });
});

describe("observability panel — Wave B full node detail sections", () => {
  const soloRun = (over: Partial<WorkflowAgentEntry>, status: WorkflowRunStatus = "completed"): PanelRun => ({
    id: "wf_detail",
    name: "detail",
    status,
    source: {
      progress: [agent({ index: 0, label: "solo", phaseIndex: 0, deps: [], dependents: [], ...over })],
      task: { status, workflowName: "detail", startTime: NOW - 5_000 },
      agentCount: 1,
    },
  });

  // Contiguous 4-space-indented body lines directly under a section label.
  const bodyUnder = (lines: string[], label: string, width: number): string[] => {
    const labelIdx = lines.indexOf(label);
    expect(labelIdx).toBeGreaterThan(-1);
    const body: string[] = [];
    for (let i = labelIdx + 1; i < lines.length; i++) {
      if (!lines[i].startsWith("    ")) break;
      expect(visibleWidth(lines[i])).toBeLessThanOrEqual(width);
      body.push(lines[i]);
    }
    return body;
  };

  it("caps a long done-node Outcome at two lines with an expand affordance by default", () => {
    const width = 40;
    const long = "found the seam ".repeat(20).trim(); // long, single line, no newlines
    const run = soloRun({ state: "done", resultPreview: long });
    const rendered = plain(renderPanelLines([run], { ...initialPanelState(), cursor: { kind: "node", id: "solo" } }, { width, now: NOW }));
    expect(bodyUnder(rendered, "  Outcome", width).length).toBeLessThanOrEqual(2);
    expect(rendered.join("\n")).toContain("expand (+");
  });

  it("expands a long done-node Outcome to the full wrap when its key is expanded", () => {
    const width = 40;
    const long = "found the seam ".repeat(20).trim();
    const run = soloRun({ state: "done", resultPreview: long });
    const rendered = plain(renderPanelLines([run], { ...initialPanelState(), cursor: { kind: "node", id: "solo" }, expandedSections: ["outcome"] }, { width, now: NOW }));
    expect(bodyUnder(rendered, "  Outcome", width).length).toBeGreaterThanOrEqual(5);
  });

  it("caps a long node Prompt at two lines by default, expanding to the full wrap on demand", () => {
    const width = 40;
    const long = "investigate the auth flow ".repeat(10).trim();
    const run = soloRun({ state: "done", promptPreview: long });
    const collapsed = plain(renderPanelLines([run], { ...initialPanelState(), cursor: { kind: "node", id: "solo" } }, { width, now: NOW }));
    expect(bodyUnder(collapsed, "  Prompt", width).length).toBeLessThanOrEqual(2);
    expect(collapsed.join("\n")).toContain("expand (+");
    const expanded = plain(renderPanelLines([run], { ...initialPanelState(), cursor: { kind: "node", id: "solo" }, expandedSections: ["prompt"] }, { width, now: NOW }));
    expect(bodyUnder(expanded, "  Prompt", width).length).toBeGreaterThanOrEqual(3);
  });

  it("caps a long failed-node Error at two lines by default, expanding to the full wrap on demand", () => {
    const width = 40;
    const long = "boom while verifying ".repeat(12).trim();
    const run = soloRun({ state: "error", error: long }, "failed");
    const collapsed = plain(renderPanelLines([run], { ...initialPanelState(), cursor: { kind: "node", id: "solo" } }, { width, now: NOW }));
    expect(bodyUnder(collapsed, "  Error", width).length).toBeLessThanOrEqual(2);
    expect(collapsed.join("\n")).toContain("expand (+");
    const expanded = plain(renderPanelLines([run], { ...initialPanelState(), cursor: { kind: "node", id: "solo" }, expandedSections: ["outcome"] }, { width, now: NOW }));
    expect(bodyUnder(expanded, "  Error", width).length).toBeGreaterThanOrEqual(3);
  });

  it("shows elapsed since startedAt and the stage on a running node's status line", () => {
    const width = 70;
    const progress: WorkflowEntry[] = [
      agent({ index: 0, label: "up", phaseIndex: 0, state: "done", deps: [], dependents: ["run"] }),
      agent({ index: 1, label: "run", phaseIndex: 1, state: "progress", agentType: "verifier", deps: ["up"], dependents: [], startedAt: NOW - 65_000 }),
    ];
    const run: PanelRun = {
      id: "wf_run",
      name: "live",
      status: "running",
      source: { progress, task: { status: "running", workflowName: "live", startTime: NOW - 90_000 }, agentCount: 2 },
    };
    const rendered = text([run], { ...initialPanelState(), cursor: { kind: "node", id: "run" } }, { width, now: NOW });
    // The detail status line (not a roster row) names the running state, its stage, and elapsed.
    const detailStatus = rendered.split("\n").find(line => line.includes("Stage 2") && line.includes("running"));
    expect(detailStatus).toBeDefined();
    expect(detailStatus).toContain("1m05s");
  });

  it("keeps expanded Outcome in the scrollable detail body", () => {
    const width = 60;
    const fullOutput = Array.from({ length: 300 }, (_, i) => `outcome-${i}`).join(" ");
    const run = soloRun({ state: "done", resultPreview: fullOutput });
    const state: PanelState = {
      ...initialPanelState(), cursor: { kind: "node", id: "solo" }, focus: "detail", expandedSections: ["outcome"],
    };
    const lines = plain(renderPanelLines([run], state, { width, rows: 24, now: NOW }));
    expect(lines.join("\n")).toContain("outcome-0");
    let advanced = applyPanelKey([run], state, "\x1b[6~", { width, rows: 24, now: NOW });
    for (let i = 0; i < 20; i++) advanced = applyPanelKey([run], advanced.state, "\x1b[6~", { width, rows: 24, now: NOW });
    expect(plain(advanced.lines).join("\n")).toContain("outcome-299");
  });

  it("keeps model / elapsed / runtime readable (muted), reserving dim for chrome (fix #4)", () => {
    const width = 80;
    const progress: WorkflowEntry[] = [
      agent({ index: 0, label: "up", phaseIndex: 0, state: "done", deps: [], dependents: ["run"] }),
      agent({ index: 1, label: "run", phaseIndex: 1, state: "progress", agentType: "verifier", model: "sonnet", deps: ["up"], dependents: [], startedAt: NOW - 65_000, tokens: 500, toolCalls: 2 }),
    ];
    const run: PanelRun = {
      id: "wf_color",
      name: "color",
      status: "running",
      source: { progress, task: { status: "running", workflowName: "color", startTime: NOW - 90_000 }, agentCount: 2 },
    };
    const state: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "run" } };
    // Assert on the structured segments (with .color), not the flattened text.
    const segments = renderPanelLines([run], state, { width, now: NOW }).flat();
    const statusValue = segments.find(seg => seg.text.includes("sonnet") && seg.text.includes("verifier"));
    expect(statusValue?.color).toBe("muted");
    expect(statusValue?.color).not.toBe("dim");
    const runtimeValue = segments.find(seg => seg.text.includes("tok") && seg.text.includes("tools"));
    expect(runtimeValue?.color).not.toBe("dim");
  });
});

describe("observability panel — footer hints per focus", () => {
  const opts = { width: 120, now: NOW } as const;

  it("keeps run navigation in the footer but not the header", () => {
    const rendered = text([graphRun(), otherRun()], { ...initialPanelState(), cursor: { kind: "node", id: "a" } }, opts);
    expect(rendered).toContain("↑↓ move");
    expect(rendered).toContain("⏎ detail");
    expect(rendered).toContain("space fold");
    expect(rendered).toContain("←→ run");
    expect(rendered.split("\n").slice(0, 2).join("\n")).not.toContain("←→ run");
    expect(rendered).toContain("esc close");
  });

  it("reads the detail hints in detail focus", () => {
    const rendered = text([graphRun()], { ...initialPanelState(), cursor: { kind: "node", id: "a" }, focus: "detail" }, opts);
    expect(rendered).toContain("↑↓ section");
    expect(rendered).toContain("⏎ expand");
    expect(rendered).toContain("f filter");
    expect(rendered).toContain("esc back");
  });
});

describe("observability panel — Wave C open conversation", () => {
  const recordRun = (): PanelRun => ({
    id: "wf_c",
    name: "convo",
    status: "running",
    source: {
      progress: [
        agent({ index: 0, label: "a", phaseIndex: 0, state: "done", deps: [], dependents: ["b"], recordId: "rec-a" }),
        agent({ index: 1, label: "b", phaseIndex: 1, state: "progress", deps: ["a"], dependents: [], startedAt: NOW - 1_000 }),
      ],
      task: { status: "running", workflowName: "convo", startTime: NOW - 5_000 },
      agentCount: 2,
    },
  });

  it("emits an open action for c on a node cursor whose entry has a recordId, without closing", () => {
    const state: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "a" } };
    const r = applyPanelKey([recordRun()], state, "c", { width: 80, now: NOW });
    expect(r.action).toEqual({ kind: "open", recordId: "rec-a" });
    expect(r.close).toBe(false);
  });

  it("emits no action for c on a node cursor without a recordId", () => {
    const state: PanelState = { ...initialPanelState(), cursor: { kind: "node", id: "b" } };
    const r = applyPanelKey([recordRun()], state, "c", { width: 80, now: NOW });
    expect(r.action).toBeUndefined();
  });

  it("emits no action for c on a stage cursor", () => {
    const state: PanelState = { ...initialPanelState(), cursor: { kind: "stage", stage: 0 } };
    const r = applyPanelKey([recordRun()], state, "c", { width: 80, now: NOW });
    expect(r.action).toBeUndefined();
  });

  it("shows the c convo hint only for a node-with-recordId cursor and reads ↑↓ move", () => {
    const opts = { width: 120, now: NOW } as const;
    const withRecord = text([recordRun()], { ...initialPanelState(), cursor: { kind: "node", id: "a" } }, opts);
    expect(withRecord).toContain("c convo");
    expect(withRecord).toContain("↑↓ move");
    expect(withRecord).not.toContain("↑↓ node");
    const noRecord = text([recordRun()], { ...initialPanelState(), cursor: { kind: "node", id: "b" } }, opts);
    expect(noRecord).not.toContain("c convo");
    const stageCursor = text([recordRun()], { ...initialPanelState(), cursor: { kind: "stage", stage: 0 } }, opts);
    expect(stageCursor).not.toContain("c convo");
  });
});
