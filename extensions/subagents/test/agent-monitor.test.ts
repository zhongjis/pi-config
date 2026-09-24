import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { historyFleetGraphRun } from "../src/graph/graph-runtime.js";
import type { HistoricalGraphRun } from "../src/graph/history-view.js";
import type { AgentRecord } from "../src/types.js";
import {
  AgentMonitor,
  type AgentMonitorDeps,
  MONITOR_AGENT_CAP,
  monitorSections,
  monitorStatusWord,
  showAgentMonitor,
} from "../src/ui/agent-monitor.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";
import type { FleetGraphRun } from "../src/ui/fleet-list.js";
import type { GraphRunUIContext } from "../src/ui/graph-run-menu.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ESC = "\x1b";
const ENTER = "\r";
const CTRL_C = "\x03";

const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => `*${s}*` };

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "Sleep then report 1",
    status: "running",
    toolUses: 0,
    startedAt: 1_000,
    lifetimeUsage: { input: 13_100, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  };
}

function makeRun(over: Partial<FleetGraphRun> = {}): FleetGraphRun {
  return {
    id: "g1",
    name: "audit",
    status: "running",
    doneCount: 1,
    totalCount: 2,
    startedAt: 1_000,
    tokens: 10,
    ...over,
  };
}

const opened: AgentMonitor[] = [];
afterEach(() => {
  for (const monitor of opened) monitor.dispose();
  opened.length = 0;
});

function setup(opts: {
  graphRuns?: FleetGraphRun[];
  agents?: AgentRecord[];
  activity?: Map<string, AgentActivity>;
  detach?: AgentMonitorDeps["detach"];
  openGraphRun?: AgentMonitorDeps["openGraphRun"];
  viewAgentConversation?: AgentMonitorDeps["viewAgentConversation"];
  viewportPct?: number;
  rows?: number;
} = {}) {
  const notify = vi.fn();
  const ctx = { ui: { notify } } as GraphRunUIContext;
  const overlay = { setHidden: vi.fn() };
  const done = vi.fn();
  const openGraphRun = opts.openGraphRun ?? vi.fn(async () => {});
  const viewAgentConversation = opts.viewAgentConversation ?? vi.fn(async () => {});
  const deps: AgentMonitorDeps = {
    listAgents: () => opts.agents ?? [],
    agentActivity: opts.activity ?? new Map(),
    graphRuns: () => opts.graphRuns ?? [],
    openGraphRun,
    viewAgentConversation,
    ...(opts.detach ? { detach: opts.detach } : {}),
  };
  const tui = { terminal: { rows: opts.rows ?? 40 }, requestRender: vi.fn() } as unknown as TUI;
  const component = new AgentMonitor(tui, theme, done, ctx, deps, {
    viewportPct: opts.viewportPct ?? 70,
    getOverlay: () => overlay,
  });
  opened.push(component);
  return {
    component,
    notify,
    overlay,
    done,
    openGraphRun,
    viewAgentConversation,
    ctx,
    render: (width = 120) => component.render(width).join("\n"),
    lines: (width = 120) => component.render(width),
  };
}

describe("monitorSections", () => {
  const graphRuns = [
    makeRun({ id: "old-done", status: "completed", startedAt: 100, completedAt: 200 }),
    makeRun({ id: "new-done", status: "failed", startedAt: 300, completedAt: 900 }),
    makeRun({ id: "live-late", status: "running", startedAt: 500 }),
    makeRun({ id: "live-early", status: "paused", startedAt: 400 }),
    makeRun({ id: "stopped", status: "killed", startedAt: 50, completedAt: 80 }),
  ];
  const agents = [
    makeRecord({ id: "owned", graphRunId: "live-late", status: "running", description: "owned child", startedAt: 800 }),
    makeRecord({ id: "live-late", status: "running", startedAt: 700 }),
    makeRecord({ id: "live-early", status: "queued", startedAt: 600 }),
    makeRecord({ id: "old-done", status: "completed", startedAt: 100, completedAt: 150 }),
    makeRecord({ id: "new-done", status: "error", startedAt: 200, completedAt: 800 }),
    makeRecord({ id: "halted", status: "stopped", startedAt: 40, completedAt: 400 }),
  ];

  it("excludes graph-owned agents and orders live first, then newest first", () => {
    const sections = monitorSections(graphRuns, agents, "all");
    expect(sections.agents.some(agent => agent.graphRunId)).toBe(false);
    expect(sections.agents.map(agent => agent.id)).not.toContain("owned");
    expect(sections.graphRuns.map(run => run.id)).toEqual(["live-late", "live-early", "new-done", "old-done", "stopped"]);
    expect(sections.agents.map(agent => agent.id)).toEqual(["live-late", "live-early", "new-done", "halted", "old-done"]);
  });

  it("applies the running and failed filters", () => {
    expect(monitorSections(graphRuns, agents, "running").graphRuns.map(run => run.id)).toEqual(["live-late", "live-early"]);
    expect(monitorSections(graphRuns, agents, "running").agents.map(agent => agent.id)).toEqual(["live-late", "live-early"]);
    expect(monitorSections(graphRuns, agents, "failed").graphRuns.map(run => run.id)).toEqual(["new-done"]);
    expect(monitorSections(graphRuns, agents, "failed").agents.map(agent => agent.id)).toEqual(["new-done"]);
  });

  it("caps independent agents at 50 after ordering and does not cap graph runs", () => {
    const finished = Array.from({ length: 51 }, (_, index) => makeRecord({
      id: `a${index}`,
      status: "completed",
      startedAt: index,
      completedAt: index,
    }));
    const capped = monitorSections([], finished, "all");
    expect(MONITOR_AGENT_CAP).toBe(50);
    expect(capped.agents).toHaveLength(50);
    expect(capped.agents[0]?.id).toBe("a50");
    expect(capped.agents.at(-1)?.id).toBe("a1");
    expect(capped.agents.some(agent => agent.id === "a0")).toBe(false);

    const runs = Array.from({ length: 21 }, (_, index) => makeRun({
      id: `g${index}`,
      status: "completed",
      startedAt: index,
      completedAt: index,
    }));
    expect(monitorSections(runs, [], "all").graphRuns).toHaveLength(21);
  });
});

describe("monitorStatusWord", () => {
  it("uses the monitor vocabulary for graph runs and agents", () => {
    expect(monitorStatusWord(makeRun({ status: "running" }))).toBe("running");
    expect(monitorStatusWord(makeRun({ status: "paused" }))).toBe("paused");
    expect(monitorStatusWord(makeRun({ status: "completed" }))).toBe("done");
    expect(monitorStatusWord(makeRun({ status: "failed" }))).toBe("failed");
    expect(monitorStatusWord(makeRun({ status: "killed" }))).toBe("stopped");
    expect(monitorStatusWord(makeRecord({ status: "queued" }))).toBe("queued");
    expect(monitorStatusWord(makeRecord({ status: "running" }))).toBe("running");
    expect(monitorStatusWord(makeRecord({ status: "completed" }))).toBe("done");
    expect(monitorStatusWord(makeRecord({ status: "steered" }))).toBe("steered");
    expect(monitorStatusWord(makeRecord({ status: "aborted" }))).toBe("aborted");
    expect(monitorStatusWord(makeRecord({ status: "stopped" }))).toBe("stopped");
    expect(monitorStatusWord(makeRecord({ status: "error" }))).toBe("failed");
  });
});

describe("historyFleetGraphRun", () => {
  it("counts done agents and sums tokens from collapsed progress", () => {
    const run: HistoricalGraphRun = {
      type: "history",
      id: "hist-1",
      graphRunName: "audit",
      status: "completed",
      startTime: 1_000,
      endTime: 4_000,
      totalPausedMs: 0,
      agentCount: 5,
      graphRunProgress: [
        { type: "graph_run_agent", index: 0, label: "one", state: "done", tokens: 10 },
        { type: "graph_run_agent", index: 1, label: "two", state: "done", tokens: 20 },
        { type: "graph_run_agent", index: 2, label: "three", state: "error", tokens: 7 },
      ],
      meta: { name: "audit", description: "", phases: [] },
      history: { omittedNodeCount: 0 },
    };
    const mapped = historyFleetGraphRun(run);
    expect(mapped.doneCount).toBe(2);
    expect(mapped.totalCount).toBe(run.agentCount);
    expect(mapped.tokens).toBe(37);
    expect(mapped).toMatchObject({
      id: "hist-1",
      name: "audit",
      status: "completed",
      startedAt: 1_000,
      completedAt: 4_000,
    });
  });
});

describe("AgentMonitor", () => {
  it("renders both headers, placeholders, the empty-session line, and finished status words", () => {
    const empty = setup();
    const emptyText = empty.render();
    expect(emptyText).toContain("Agent Monitor");
    expect(emptyText).toContain("No agents or graph runs in this session yet.");
    expect(emptyText).not.toContain("agent graph runs");
    expect(emptyText).not.toContain("independent agents");

    const finished = setup({
      graphRuns: [makeRun({ id: "g-done", name: "audit", status: "completed", startedAt: 1_000, completedAt: 2_000 })],
      agents: [makeRecord({ id: "a-err", description: "boom", status: "error", startedAt: 1_100, completedAt: 2_100 })],
    });
    const text = finished.render();
    expect(text).toContain("── agent graph runs ──");
    expect(text).toContain("── independent agents ──");
    expect(text).toContain("audit");
    expect(text).toContain("boom");
    expect(text).toContain("done");
    expect(text).toContain("failed");
    expect(text).not.toContain("owned child");

    const placeholders = setup({
      graphRuns: [makeRun({ id: "settled", status: "completed", completedAt: 2_000 })],
      agents: [makeRecord({ id: "settled-agent", status: "completed", completedAt: 2_000 })],
    });
    placeholders.component.handleInput("f");
    const filtered = placeholders.render();
    expect(filtered).toContain("── agent graph runs ──");
    expect(filtered).toContain("── independent agents ──");
    expect(filtered.split("(none)")).toHaveLength(3);
    expect(filtered).toContain("filter: running");
  });

  it("keeps graph-owned agents out of the independent section and uses live activity tokens", () => {
    const record = makeRecord({
      id: "solo",
      description: "independent",
      lifetimeUsage: { input: 1, output: 0, cacheWrite: 0 },
    });
    const activity = new Map<string, AgentActivity>([[
      "solo",
      {
        activeTools: new Map(),
        toolUses: 0,
        responseText: "",
        turnCount: 0,
        lifetimeUsage: { input: 2_000, output: 0, cacheWrite: 0 },
      },
    ]]);
    const harness = setup({
      agents: [
        record,
        makeRecord({ id: "child", graphRunId: "g1", description: "hidden child", status: "running" }),
      ],
      activity,
    });
    const text = harness.render();
    expect(text).toContain("independent");
    expect(text).toContain("↓ 2.0k tokens");
    expect(text).not.toContain("hidden child");
    expect(text).toContain("(none)");
  });

  it("clamps every line to the render width", () => {
    const harness = setup({
      graphRuns: [makeRun({ name: "n".repeat(80), status: "completed", completedAt: 2_000 })],
      agents: [makeRecord({ description: "d".repeat(80), status: "error", completedAt: 2_000 })],
    });
    for (const line of harness.lines(32)) expect(visibleWidth(line)).toBeLessThanOrEqual(32);
  });

  it("keeps the selected row visible and shows more indicators", () => {
    const now = Date.now();
    const graphRuns = Array.from({ length: 20 }, (_, index) => makeRun({
      id: `g${index}`,
      name: `run-${index}`,
      status: "running",
      startedAt: now - index,
    }));
    const harness = setup({ graphRuns, viewportPct: 10, rows: 40 });
    const top = harness.render(160);
    expect(top).toContain("run-0");
    expect(top).toContain("↓");
    expect(top).toContain("more");
    for (let step = 0; step < 30; step++) harness.component.handleInput("j");
    const bottom = harness.render(160);
    expect(bottom).toContain("run-19");
    expect(bottom).toContain("↑");
    expect(bottom).not.toContain("run-0");
    expect(bottom).toContain("esc close");
  });

  it("moves without wrapping and clamps when the selected entry vanishes", () => {
    const now = Date.now();
    const runs = [
      makeRun({ id: "a", name: "alpha", status: "running", startedAt: now }),
      makeRun({ id: "b", name: "beta", status: "running", startedAt: now - 10 }),
      makeRun({ id: "c", name: "gamma", status: "running", startedAt: now - 20 }),
    ];
    const harness = setup({ graphRuns: runs });
    const shown = () => harness.render(160);
    expect(shown()).toContain("<text>alpha</text>");
    harness.component.handleInput(UP);
    expect(shown()).toContain("<text>alpha</text>");
    harness.component.handleInput("j");
    expect(shown()).toContain("<text>beta</text>");
    harness.component.handleInput(DOWN);
    expect(shown()).toContain("<text>gamma</text>");
    harness.component.handleInput(DOWN);
    expect(shown()).toContain("<text>gamma</text>");
    harness.component.handleInput("k");
    expect(shown()).toContain("<text>beta</text>");
    runs.splice(1, 1);
    expect(shown()).toContain("<text>gamma</text>");
    expect(shown()).not.toContain("beta");
  });

  it("opens a graph run and hides the overlay until it returns", async () => {
    let release: () => void = () => {};
    const openGraphRun = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const harness = setup({ graphRuns: [makeRun({ id: "g9", name: "audit" })], openGraphRun });
    harness.component.handleInput(ENTER);
    expect(harness.overlay.setHidden).toHaveBeenCalledWith(true);
    expect(openGraphRun).toHaveBeenCalledWith(harness.ctx, "g9");
    expect(harness.overlay.setHidden).not.toHaveBeenCalledWith(false);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.overlay.setHidden).toHaveBeenLastCalledWith(false);
  });

  it("warns when a graph run fails to open and still unhides the overlay", async () => {
    const openGraphRun = vi.fn(async () => { throw new Error("gone"); });
    const harness = setup({ graphRuns: [makeRun({ id: "g9" })], openGraphRun });
    harness.component.handleInput(ENTER);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.notify).toHaveBeenCalledWith("Could not open the graph run: gone", "warning");
    expect(harness.overlay.setHidden).toHaveBeenLastCalledWith(false);
  });

  it("opens an independent agent's conversation", async () => {
    const record = makeRecord({ id: "a9", description: "watch me" });
    const harness = setup({ agents: [record] });
    harness.component.handleInput(ENTER);
    expect(harness.overlay.setHidden).toHaveBeenCalledWith(true);
    expect(harness.viewAgentConversation).toHaveBeenCalledWith(harness.ctx, record);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.overlay.setHidden).toHaveBeenLastCalledWith(false);
  });

  it("detaches a selected graph run when a pane is available", () => {
    const open = vi.fn(async () => true);
    const harness = setup({
      graphRuns: [makeRun({ id: "g1", name: "audit" })],
      detach: { available: () => true, open },
    });
    expect(harness.render()).toContain("o detach");
    harness.component.handleInput("o");
    expect(open).toHaveBeenCalledWith("g1");
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it("warns when detach is unavailable", () => {
    const open = vi.fn(async () => false);
    const harness = setup({
      graphRuns: [makeRun({ id: "g1" })],
      detach: { available: () => false, open },
    });
    expect(harness.render()).not.toContain("o detach");
    harness.component.handleInput("o");
    expect(harness.notify).toHaveBeenCalledWith("Detach needs a Herdr-managed pane.", "warning");
    expect(open).not.toHaveBeenCalled();

    const missing = setup({ graphRuns: [makeRun({ id: "g2" })] });
    missing.component.handleInput("o");
    expect(missing.notify).toHaveBeenCalledWith("Detach needs a Herdr-managed pane.", "warning");
  });

  it("refuses to detach an independent agent", () => {
    const open = vi.fn(async () => true);
    const harness = setup({
      agents: [makeRecord({ id: "a1", description: "solo" })],
      detach: { available: () => true, open },
    });
    harness.component.handleInput("o");
    expect(harness.notify).toHaveBeenCalledWith("Detach supports agent graph runs only.", "info");
    expect(open).not.toHaveBeenCalled();
    expect(harness.render()).not.toContain("o detach");
  });

  it("cycles the filter and selects the first row", () => {
    const now = Date.now();
    const harness = setup({
      graphRuns: [
        makeRun({ id: "live", name: "alpha", status: "running", startedAt: now }),
        makeRun({ id: "older", name: "beta", status: "running", startedAt: now - 10 }),
        makeRun({ id: "done", name: "gamma", status: "completed", startedAt: now - 30, completedAt: now - 20 }),
      ],
    });
    const shown = (width = 160) => harness.render(width);
    harness.component.handleInput("j");
    expect(shown()).toContain("<text>beta</text>");
    harness.component.handleInput("f");
    const running = shown();
    expect(running).toContain("filter: running");
    expect(running).toContain("<text>alpha</text>");
    expect(running).not.toContain("gamma");
    harness.component.handleInput("f");
    expect(shown()).toContain("filter: failed");
    harness.component.handleInput("f");
    const all = shown();
    expect(all).not.toContain("filter:");
    expect(all).toContain("alpha");
    expect(all).toContain("gamma");
    expect(all).toContain("<text>alpha</text>");
  });

  it("closes on esc, q, and ctrl+c", () => {
    for (const key of [ESC, "q", CTRL_C]) {
      const harness = setup({ graphRuns: [makeRun()] });
      harness.component.handleInput(key);
      expect(harness.done).toHaveBeenCalledWith(undefined);
      harness.component.handleInput("j");
      expect(harness.done).toHaveBeenCalledTimes(1);
    }
  });
});

describe("showAgentMonitor", () => {
  it("opens a centered overlay at the shared viewport height", async () => {
    const done = vi.fn();
    const custom = vi.fn(async (factory: (tui: TUI, theme: typeof theme, keybindings: unknown, done: (result: undefined) => void) => AgentMonitor, options?: { overlay?: boolean; overlayOptions?: { anchor?: string; width?: string; maxHeight?: string }; onHandle?: (handle: { setHidden(hidden: boolean): void }) => void }) => {
      expect(options).toMatchObject({
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" },
      });
      const component = factory({ terminal: { rows: 40 }, requestRender() {} } as unknown as TUI, theme, {}, done);
      opened.push(component);
      options?.onHandle?.({ setHidden: vi.fn() });
      component.handleInput(ESC);
    });
    const ctx = { ui: { custom, notify: vi.fn() } } as unknown as GraphRunUIContext;
    await showAgentMonitor(ctx, {
      listAgents: () => [],
      agentActivity: new Map(),
      graphRuns: () => [],
      openGraphRun: async () => {},
      viewAgentConversation: async () => {},
    });
    expect(custom).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(undefined);
  });
});
