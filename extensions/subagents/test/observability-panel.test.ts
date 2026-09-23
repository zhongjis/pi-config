// observability-panel.test.ts — the /graph-runs pane's default view. Pure and
// terminal-free, tested through the one seam (renderPanelLines / applyPanelKey),
// asserting on produced lines and next state, never on private layout internals.
// Exercise the REAL terminal-cell layout (not the ASCII unit stub) so the
// width-safety assertion means what it says, mirroring workflow-pane-render.test.ts.
vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { renderObservabilityPaneLines } from "../src/graph/pane/render.js";
import type { WorkflowAgentEntry } from "../src/graph/progress.js";
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

const plain = (lines: ReturnType<typeof renderPanelLines>): string[] => lines.map(line => line.map(segment => segment.text).join(""));
const opts = { width: 120, now: NOW };
function fixture(): PanelRun {
  const progress: WorkflowAgentEntry[] = [];
  const add = (id: string, data: Partial<WorkflowAgentEntry>) => progress.push(agent({ index: progress.length, label: id, nodeBinding: id, instanceId: `${id}-uuid`, state: "done", ...data }));
  add("research", { presentation: { kind: "bounded_feedback", name: "Research", iterations: [{ iteration: 1, decision: "continue" }, { iteration: 2, decision: "sufficient" }] } });
  for (const iteration of [1, 2]) {
    const work = `work-${iteration}`;
    add(work, { label: `Gather evidence · iteration ${iteration}`, presentation: { kind: "fanout", name: "Gather evidence", parentInstanceId: "research-uuid", iteration, role: "work" }, dependents: [`eval-${iteration}`] });
    for (let itemIndex = 0; itemIndex < (iteration === 1 ? 4 : 1); itemIndex++) {
      add(`${work}-${itemIndex}`, { label: `Gather evidence · iteration ${iteration} · item ${itemIndex + 1}`, agentType: "chengfeng", model: "GPT-5.6 Luna", recordId: `record-${iteration}-${itemIndex}`, nodeKey: "research", promptPreview: "retained prompt ".repeat(40), resultPreview: "retained outcome ".repeat(40), tokens: 45423, toolCalls: 11, durationMs: 45000, deps: [work], dependents: [`eval-${iteration}`], presentation: { kind: "agent", name: "not a structural label", parentInstanceId: `${work}-uuid`, iteration, itemIndex, role: "item" } });
    }
    add(`eval-${iteration}`, { label: `Evaluate evidence · iteration ${iteration}`, agentType: "direnjie", model: "GPT-5.6 Sol", presentation: { kind: "agent", name: "Evaluate evidence", parentInstanceId: "research-uuid", iteration, role: "evaluator" } });
  }
  add("synthesis", { presentation: { kind: "agent", name: "Synthesize context" }, agentType: "jintong", model: "GPT-5.6 Terra", deps: ["research"] });
  return { id: "fixture", name: "context-gather", status: "completed", source: { progress, meta: { name: "context-gather", description: "Adaptively gather evidence with one gap-closing pass" }, task: { status: "completed", startTime: NOW - 160000, endTime: NOW } } };
}
const selected = (): PanelState => ({ ...initialPanelState(), cursor: { kind: "node", id: "work-1-2" } });
function render(run = fixture(), state = selected(), options: Parameters<typeof renderPanelLines>[2] = opts): string[] { return plain(renderPanelLines([run], state, options)); }
function roster(lines: string[]): string[] { const n = lines.findIndex(line => line.includes("Selected node")); return n < 0 ? lines : lines.slice(0, n); }

describe("Herdr presentation", () => {
  it("matches the accepted mock's identity, aggregate, tree order, decisions and density", () => {
    const lines = render(); const rows = roster(lines);
    expect(rows.filter(line => line.includes("context-gather"))).toHaveLength(1);
    expect(rows[0]).toMatch(/context-gather\s+COMPLETED/);
    expect(rows.join("\n")).toContain("8 agents · 3 coordination nodes · 2 iterations · 2m40s");
    expect(rows.join("\n")).toContain("11/11 nodes");
    expect(rows.filter(line => /✓ done/.test(line))).toHaveLength(11);
    expect(rows.filter(line => /↻ Iteration/.test(line))).toHaveLength(2);
    expect(rows.filter(line => /continue|sufficient/.test(line))).toHaveLength(2);
    const nodes = rows.filter(line => /✓ done|↻ Iteration/.test(line));
    expect(nodes.map(line => line.replace(/^.*(?:✓ done\s+|↻ )/, "").trim().split(/\s{2,}/)[0])).toEqual([
      "Research", "Iteration 1", "Gather evidence", "item 1", "item 2", "item 3", "item 4", "Evaluate evidence", "Iteration 2", "Gather evidence", "item 1", "Evaluate evidence", "Synthesize context",
    ]);
    expect(nodes.find(line => line.includes("item 3"))).toMatch(/^   › │  │  │  ├─ ✓ done/);
    expect(nodes.at(-1)).toMatch(/^     └─ ✓ done/);
    expect(rows.join("\n")).not.toMatch(/running 0|queued 0|failed 0|Stage|model pending/);
  });
  it("keeps node identity at normal contrast and dims only trailing annotations/chrome", () => {
    const lines = renderPanelLines([fixture()], initialPanelState(), opts);
    for (const name of ["Research", "Gather evidence", "Evaluate evidence", "item 3"]) {
      const row = lines.find(line => line.some(segment => segment.text.includes(name)));
      expect(row?.find(segment => segment.text.includes(name))?.color).toBeUndefined();
    }
    expect(lines.flat().find(segment => segment.text.includes("bounded feedback"))?.color).toBe("dim");
  });
  it("keeps selection independent from lifecycle and rails in both colorless and ANSI renderers", () => {
    const line = roster(render()).find(line => line.includes("item 3"));
    expect(line).toContain("› │  │  │  ├─ ✓ done");
    const ansi = renderObservabilityPaneLines([fixture()], selected(), opts).filter(line => line.includes("\x1b[7m"));
    expect(ansi).toHaveLength(1); expect(visibleWidth(ansi[0])).toBe(120);
    expect(stripTerminalSequences(ansi[0])).toContain("✓ done");
  });
  it("puts prompt and outcome before collapsed identity metadata, preserving complete binding identity", () => {
    const detail = render().join("\n").split("Selected node")[1];
    const order = ["Gather evidence · iteration 1 · item 3", "Completed", "Flow", "Prompt", "Outcome", "Metadata", "Key: research", "Instance:"];
    for (let i = 1; i < order.length; i++) expect(detail.indexOf(order[i])).toBeGreaterThan(detail.indexOf(order[i-1]));
    expect(detail).toContain("this agent"); expect(detail).toContain("45,423 tokens · 11 tools");
    expect(detail).not.toContain("work-1-2-uuid");
    expect(render(fixture(), { ...selected(), expandedSections: ["identity"] }).join("\n")).toContain("work-1-2-uuid");
    expect(detail).toMatch(/Enter expand \(\+\d+ lines\)/);
  });
  it("keeps non-linear dependencies explicit and never makes a DAG edge containment", () => {
    const run = fixture(); const last = run.source.progress.at(-1);
    if (last?.type !== "workflow_agent") throw new Error("fixture");
    last.deps = ["research", "eval-1"]; last.dependents = ["unknown-a", "unknown-b"];
    const lines = render(run, { ...selected(), cursor: { kind: "node", id: "synthesis" } });
    expect(lines.join("\n")).toContain("Upstream: research, Evaluate evidence · iteration 1");
    expect(lines.join("\n")).toContain("Downstream: unknown-a, unknown-b");
    expect(roster(lines).find(line => line.includes("Synthesize context"))).toMatch(/^   › └─/);
  });
  it("uses explicit flat fallback for legacy labels, without guessing agent counts or iterations", () => {
    const run = fixture(); run.source.progress = [agent({ index: 0, label: "Research · iteration 99 · item 4", state: "done", agentType: "agent", phaseIndex: 42 })];
    const lines = render(run, initialPanelState());
    expect(lines.join("\n")).toContain("1 unclassified node"); expect(lines.join("\n")).toContain("Flat fallback");
    expect(lines.join("\n")).not.toMatch(/↻|99 iterations|Stage 43|1 agent/);
  });
  it.each([false, true])("shows all lifecycle states and replay annotation (ASCII=%s)", ascii => {
    const run = fixture(); run.status = "running";
    run.source.progress = [
      agent({ index: 0, label: "done-node", state: "done", cached: true }),
      agent({ index: 1, label: "running-node", state: "progress", startedAt: NOW - 100 }),
      agent({ index: 2, label: "queued-node", queuedAt: NOW }),
      agent({ index: 3, label: "blocked-node", state: "error", blocked: true }),
      agent({ index: 4, label: "failed-node", state: "error" }),
      agent({ index: 5, label: "skipped-node", state: "error", skipped: true }),
    ];
    const output = render(run, initialPanelState(), { ...opts, ascii }).join("\n");
    for (const status of ascii ? ["+ done", "* running", "o queued", "! blocked", "x failed", "- skipped"] : ["✓ done", "● running", "○ queued", "! blocked", "× failed", "– skipped"]) expect(output).toContain(status);
    expect(output).toMatch(/done\s+done-node · replayed/);
    run.status = "paused";
    expect(render(run, initialPanelState(), { ...opts, ascii }).join("\n")).toContain(ascii ? "|| paused" : "Ⅱ paused");
    run.status = "killed";
    expect(render(run, initialPanelState(), { ...opts, ascii }).join("\n")).toContain(ascii ? "# stopped" : "■ stopped");
  });
  it("has a complete ASCII tree and iteration fallback", () => {
    const output = render(fixture(), selected(), { ...opts, ascii: true }).join("\n");
    expect(output).toContain("Iteration 1"); expect(output).toContain("+- + done");
    expect(output).not.toMatch(/[↻✓│└├─›▾▸↑↓←→Ⅱ■]/);
  });
  it("is cell-safe at the public ANSI seam including zero and grapheme-sized widths", () => {
    const run = fixture(); run.name = "漢字👩‍💻é".repeat(20);
    const item = run.source.progress[3]; if (item.type !== "workflow_agent") throw new Error("fixture");
    item.label = "漢字👩‍💻é".repeat(20); item.model = "very-long-model".repeat(20); item.instanceId = "uuid".repeat(40);
    item.promptPreview = item.resultPreview = "\x1b[31m漢字👩‍💻é\x1b[0m ".repeat(30);
    for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) for (const ascii of [false, true]) for (const rows of [undefined, 12, 40]) {
      for (const line of renderObservabilityPaneLines([run], { ...selected(), expandedSections: ["prompt", "outcome", "identity"] }, { width, rows, ascii, now: NOW })) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width); expect(stripTerminalSequences(line)).not.toMatch(/[\r\n]/);
      }
    }
  });
});

describe("Herdr read-only navigation", () => {
  it("walks structural targets and folds iterations without opening conversations", () => {
    let state = initialPanelState();
    const seen: PanelState["cursor"][] = [];
    for (let i = 0; i < 4; i++) { state = applyPanelKey([fixture()], state, "j", opts).state; seen.push(state.cursor); }
    expect(seen).toEqual([{ kind: "stage", stage: 0 }, { kind: "node", id: "research" }, { kind: "iteration", owner: "research", iteration: 1 }, { kind: "node", id: "work-1" }]);
    state = applyPanelKey([fixture()], state, "k", opts).state;
    expect(applyPanelKey([fixture()], state, "c", opts).action).toBeUndefined();
    const folded = applyPanelKey([fixture()], state, " ", opts);
    expect(plain(folded.lines).join("\n")).not.toContain("item 3"); expect(folded.state.cursor).toEqual(state.cursor);
    const reopened = applyPanelKey([fixture()], folded.state, "\r", opts);
    expect(plain(reopened.lines).join("\n")).toContain("item 3");
  });
  it("retains ancestors of a filtered descendant and preserves selected identity across materialization", () => {
    const run = fixture(); run.status = "running";
    const item = run.source.progress[4]; if (item.type !== "workflow_agent") throw new Error("fixture"); item.state = "progress"; item.startedAt = NOW;
    const next = applyPanelKey([run], selected(), "f", opts);
    expect(next.state.cursor).toEqual(selected().cursor);
    const output = roster(plain(next.lines)).join("\n");
    for (const label of ["Research", "Iteration 1", "Gather evidence", "item 3"]) expect(output).toContain(label);
    expect(output).not.toContain("Iteration 2"); expect(output).not.toContain("Evaluate evidence");
    expect(applyPanelKey([run], next.state, "f", opts).state.filter).toBe("failed");
    expect(applyPanelKey([run], { ...next.state, filter: "failed" }, "f", opts).state.filter).toBe("all");
  });
  it("expands retained sections with Enter/Space, moves focus and backs out before closing", () => {
    const entered = applyPanelKey([fixture()], selected(), "\r", opts);
    expect(entered.state.focus).toBe("detail");
    const expanded = applyPanelKey([fixture()], entered.state, "\r", opts);
    expect(expanded.state.expandedSections).toContain("prompt");
    expect(applyPanelKey([fixture()], expanded.state, " ", opts).state.expandedSections).not.toContain("prompt");
    const outcome = applyPanelKey([fixture()], entered.state, "j", opts);
    expect(outcome.state.detailCursor).toBe(1);
    expect(applyPanelKey([fixture()], outcome.state, "\r", opts).state.expandedSections).toContain("outcome");
    const back = applyPanelKey([fixture()], entered.state, "\x1b", opts);
    expect(back.close).toBe(false); expect(back.state.focus).toBe("roster");
    expect(applyPanelKey([fixture()], back.state, "\x1b", opts).close).toBe(true);
  });
  it("switches runs, resets folds/scroll/selection, but retains the filter", () => {
    const start = { ...selected(), filter: "failed" as const, scroll: 5, collapsedTargets: [{ kind: "iteration" as const, owner: "research", iteration: 1 }] };
    const next = applyPanelKey([fixture(), { ...fixture(), id: "second", name: "second" }], start, "\x1b[C", opts);
    expect(next.state).toMatchObject({ runIndex: 1, scroll: 0, filter: "failed", collapsedTargets: [], focus: "roster" });
    expect(next.state.cursor).toBeUndefined();
  });
  it("pages both zones independently and fills the supplied height", () => {
    for (const focus of ["roster", "detail"] as const) {
      const state = { ...selected(), focus, expandedSections: ["outcome"] };
      const next = applyPanelKey([fixture()], state, "\x1b[6~", { ...opts, rows: 24 });
      expect(next.state[focus === "detail" ? "detailScroll" : "scroll"]).toBe(5);
      expect(next.lines).toHaveLength(24);
      expect(applyPanelKey([fixture()], next.state, "\x1b[5~", opts).state[focus === "detail" ? "detailScroll" : "scroll"]).toBe(0);
    }
  });
  it("keeps inputs disclosed on demand and advertises only available keys", () => {
    const run = fixture(); run.source.input = coerceGraphInput('{"task":"Map repository","extra":{"json":true}}');
    expect(render(run).join("\n")).not.toContain("Map repository");
    const expanded = applyPanelKey([run], selected(), "e", opts);
    expect(plain(expanded.lines).join("\n")).toContain("Map repository"); expect(plain(expanded.lines).join("\n")).toContain("extra:");
    expect(plain(expanded.lines).at(-1)).toContain("e inputs");
    expect(render().at(-1)).not.toContain("e inputs"); expect(render().at(-1)).not.toContain("←→ run");
    expect(render().at(-1)).toContain("c convo");
  });
  it("opens only real nodes with conversations and ignores all execution-control keys", () => {
    expect(applyPanelKey([fixture()], selected(), "c", opts).action).toEqual({ kind: "open", recordId: "record-1-2" });
    for (const key of ["p", "s", "r", "x", "z"]) {
      const state = selected(); const result = applyPanelKey([fixture()], state, key, opts);
      expect(result.state).toBe(state); expect(result.action).toBeUndefined(); expect(result.close).toBe(false);
    }
  });
  it("handles empty runs and narrow heights without throwing", () => {
    expect(plain(renderPanelLines([], initialPanelState(), opts)).join("\n")).toContain("No graph runs");
    expect(renderPanelLines([], initialPanelState(), { ...opts, rows: 12 })).toHaveLength(12);
    expect(applyPanelKey([], initialPanelState(), "q", opts).close).toBe(true);
    for (const rows of [0, 1, 2, 12, 24, 40]) expect(renderPanelLines([fixture()], selected(), { ...opts, rows })).toHaveLength(rows);
  });
});

describe("Herdr retained detail and narrow priority", () => {
  it("derives collection flow from authoritative ownership when item dependencies are empty", () => {
    const run = fixture();
    const entry = run.source.progress[4];
    if (entry.type !== "workflow_agent") throw new Error("fixture");
    entry.deps = []; entry.dependents = [];
    const detail = render(run).join("\n").split("Selected node")[1];
    expect(detail).toContain("Gather evidence · iteration 1");
    expect(detail).toContain("this agent");
    expect(detail).toContain("Evaluate evidence · iteration 1");
    const row = roster(render(run, selected(), { width: 20, now: NOW })).find(line => line.startsWith("›"));
    expect(row).toContain("✓ done item 3");
    expect(row).not.toContain("Luna");
  });
  it("keeps conditional/loop facts explicit rather than drawing a linear flow", () => {
    const run = fixture();
    const entry = run.source.progress[4];
    if (entry.type !== "workflow_agent" || !entry.presentation) throw new Error("fixture");
    entry.presentation.connections = [{ binding: "research", direction: "upstream", kind: "loop" }, { binding: "synthesis", direction: "downstream", kind: "conditional" }];
    const detail = render(run).join("\n").split("Selected node")[1];
    expect(detail).toContain("upstream: research (loop)");
    expect(detail).toContain("downstream: synthesis (conditional)");
    expect(detail).not.toContain("this agent");
  });
  it("retains transitive failure detail, full expanded output, paging position and section focus", () => {
    const run = fixture(); run.status = "failed";
    const root = run.source.progress[0]; const child = run.source.progress[1];
    if (root.type !== "workflow_agent" || child.type !== "workflow_agent") throw new Error("fixture");
    root.state = "error"; root.error = "retained failure"; root.dependents = ["work-1"];
    child.state = "error"; child.skipped = true;
    expect(render(run, { ...selected(), cursor: { kind: "node", id: "research" } }).join("\n")).toContain("Blast radius: work-1");
    const output = fixture(); const item = output.source.progress[4];
    if (item.type !== "workflow_agent") throw new Error("fixture");
    item.resultPreview = Array.from({ length: 100 }, (_, index) => `retained-line-${index}`).join("\n");
    let state: PanelState = { ...selected(), focus: "detail", detailCursor: 1, expandedSections: ["outcome"] };
    const options = { width: 80, rows: 24, now: NOW };
    const highlighted = renderObservabilityPaneLines([output], state, options).filter(line => line.includes("\x1b[7m"));
    expect(highlighted).toHaveLength(1); expect(stripTerminalSequences(highlighted[0])).toContain("Outcome");
    for (let index = 0; index < 30; index++) state = applyPanelKey([output], state, "\x1b[6~", options).state;
    const lines = plain(renderPanelLines([output], state, options));
    expect(lines.join("\n")).toContain("retained-line-99");
    expect(lines.at(-1)).toMatch(/\d+-\d+\/\d+/);
  });
});
