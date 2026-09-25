// Real terminal-cell metrics: the unit stub strips ANSI, which would hide the frame fill.
vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

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
const ANSI_BG = "\x1b[48;5;236m";
const colorDigit: Record<string, string> = {
  accent: "1",
  success: "2",
  error: "3",
  warning: "4",
  dim: "5",
  border: "6",
  text: "7",
  borderMuted: "8",
  muted: "9",
};
const ansiTheme = {
  fg: (color: string, text: string) => `\x1b[3${colorDigit[color] ?? "0"}m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  getBgAnsi: () => ANSI_BG,
};

type MonitorTheme = typeof theme | typeof ansiTheme;

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/<\/?[^>]+>/g, "");
}

function selectedText(lines: readonly string[]): string {
  return lines.filter(line => line.includes("\x1b[7m")).map(plain).join("\n");
}

function bodyLines(lines: readonly string[]): string[] {
  const plainLines = lines.map(plain);
  const sep = plainLines.findIndex(line => line.startsWith("├"));
  return sep < 0 ? [] : plainLines.slice(1, sep);
}

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
  theme?: MonitorTheme;
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
  const component = new AgentMonitor(tui, opts.theme ?? theme, done, ctx, deps, {
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
      theme: ansiTheme,
      graphRuns: [makeRun({ id: "g-done", name: "audit", status: "completed", startedAt: 1_000, completedAt: 2_000 })],
      agents: [makeRecord({ id: "a-err", description: "boom", status: "error", startedAt: 1_100, completedAt: 2_100 })],
    });
    const text = plain(finished.render());
    expect(text).toContain("Agent graph runs");
    expect(text).toContain("Independent agents");
    expect(text).not.toContain("── agent graph runs ──");
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
    expect(filtered).toContain("Agent graph runs");
    expect(filtered).toContain("Independent agents");
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
      theme: ansiTheme,
      agents: [
        record,
        makeRecord({ id: "child", graphRunId: "g1", description: "hidden child", status: "running" }),
      ],
      activity,
    });
    const text = plain(harness.render());
    expect(text).toContain("Independent agents");
    expect(text).toContain("independent");
    expect(text).toContain("↓ 2.0k tokens");
    expect(text).not.toContain("hidden child");
    expect(text).toContain("(none)");
  });

  it("clamps every line to the render width", () => {
    // Tag markup is visible width; real theme ANSI is not. Prove the clamp with the ANSI stub.
    const harness = setup({
      theme: ansiTheme,
      graphRuns: [makeRun({ name: "n".repeat(80), status: "completed", completedAt: 2_000 })],
      agents: [makeRecord({ description: "d".repeat(80), status: "error", completedAt: 2_000 })],
    });
    for (const line of harness.lines(32)) expect(visibleWidth(line)).toBe(32);
  });

  it("keeps the selected row visible and shows more indicators", () => {
    const now = Date.now();
    const graphRuns = Array.from({ length: 20 }, (_, index) => makeRun({
      id: `g${index}`,
      name: `run-${index}`,
      status: "running",
      startedAt: now - index,
    }));
    const harness = setup({ graphRuns, viewportPct: 10, rows: 40, theme: ansiTheme });
    const top = harness.render(160);
    expect(top).toContain("run-0");
    expect(top).toContain("↓");
    expect(top).toContain("more");
    for (let step = 0; step < 30; step++) harness.component.handleInput("j");
    const bottom = harness.render(160);
    expect(bottom).toContain("run-19");
    expect(bottom).toContain("↑");
    expect(bottom).not.toContain("run-0");
    expect(plain(bottom)).toContain("esc close");
  });

  it("moves without wrapping and clamps when the selected entry vanishes", () => {
    const now = Date.now();
    const runs = [
      makeRun({ id: "a", name: "alpha", status: "running", startedAt: now }),
      makeRun({ id: "b", name: "beta", status: "running", startedAt: now - 10 }),
      makeRun({ id: "c", name: "gamma", status: "running", startedAt: now - 20 }),
    ];
    const harness = setup({ graphRuns: runs });
    const shown = () => harness.lines(160);
    expect(selectedText(shown())).toContain("alpha");
    harness.component.handleInput(UP);
    expect(selectedText(shown())).toContain("alpha");
    harness.component.handleInput("j");
    expect(selectedText(shown())).toContain("beta");
    harness.component.handleInput(DOWN);
    expect(selectedText(shown())).toContain("gamma");
    harness.component.handleInput(DOWN);
    expect(selectedText(shown())).toContain("gamma");
    harness.component.handleInput("k");
    expect(selectedText(shown())).toContain("beta");
    runs.splice(1, 1);
    expect(selectedText(shown())).toContain("gamma");
    expect(harness.render(160)).not.toContain("beta");
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
      theme: ansiTheme,
      graphRuns: [makeRun({ id: "g1", name: "audit" })],
      detach: { available: () => true, open },
    });
    expect(plain(harness.render())).toContain("o detach");
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
    expect(plain(harness.render())).not.toContain("o detach");
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
    expect(plain(harness.render())).not.toContain("o detach");
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
    const shown = (width = 160) => harness.lines(width);
    harness.component.handleInput("j");
    expect(selectedText(shown())).toContain("beta");
    harness.component.handleInput("f");
    const running = shown();
    expect(plain(running[0] ?? "")).toContain("filter: running");
    expect(running.join("\n")).not.toContain("gamma");
    expect(selectedText(running)).toContain("alpha");
    harness.component.handleInput("f");
    expect(plain(shown()[0] ?? "")).toContain("filter: failed");
    harness.component.handleInput("f");
    const all = shown();
    expect(plain(all.join("\n"))).not.toContain("filter:");
    expect(all.join("\n")).toContain("alpha");
    expect(all.join("\n")).toContain("gamma");
    expect(selectedText(all)).toContain("alpha");
  });

  it("frames the overlay, fills a solid background, and stays width-safe", () => {
    const harness = setup({
      theme: ansiTheme,
      graphRuns: [
        makeRun({ id: "live", name: "alpha", status: "running", startedAt: 2_000 }),
        makeRun({ id: "done", name: "audit", status: "completed", startedAt: 1_000, completedAt: 1_500 }),
      ],
      agents: [makeRecord({ id: "boom", description: "boom", status: "error", startedAt: 900, completedAt: 1_200 })],
    });
    const lines = harness.lines(80);
    expect(plain(lines[0] ?? "").startsWith("╭")).toBe(true);
    expect(plain(lines[0] ?? "")).toContain("Agent Monitor");
    expect(plain(lines.at(-1) ?? "").startsWith("╰")).toBe(true);
    expect(plain(lines.at(-3) ?? "").startsWith("├")).toBe(true);
    expect(plain(lines.at(-2) ?? "")).toContain("esc close");
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(80);
      expect(line.startsWith(ANSI_BG)).toBe(true);
      expect(line.endsWith("\x1b[49m")).toBe(true);
      const body = line.slice(ANSI_BG.length, -"\x1b[49m".length);
      for (const token of ["\x1b[0m", "\x1b[49m"]) {
        let index = body.indexOf(token);
        while (index !== -1) {
          expect(body.slice(index + token.length, index + token.length + ANSI_BG.length)).toBe(ANSI_BG);
          index = body.indexOf(token, index + token.length);
        }
      }
    }

    for (const width of [6, 20, 40, 80, 120]) {
      for (const line of harness.lines(width)) expect(visibleWidth(line)).toBe(width);
    }
    expect(harness.lines(0)).toEqual([]);
    for (const width of [1, 5]) {
      const narrow = harness.lines(width);
      expect(narrow.some(line => plain(line).startsWith("╭"))).toBe(false);
      for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("does not paint a background when the theme has no fill", () => {
    const harness = setup({ graphRuns: [makeRun()] });
    expect(harness.render()).not.toContain("\x1b[48");
  });

  it("shows section counts and state-colored status on unselected rows", () => {
    const harness = setup({
      theme: ansiTheme,
      graphRuns: [
        makeRun({ id: "live", name: "alpha", status: "running", startedAt: 3_000 }),
        makeRun({ id: "done", name: "audit", status: "completed", startedAt: 1_000, completedAt: 1_500 }),
      ],
      agents: [
        makeRecord({ id: "live-agent", description: "working", status: "running", startedAt: 2_000 }),
        makeRecord({ id: "boom", description: "boom", status: "error", startedAt: 900, completedAt: 1_200 }),
      ],
    });
    harness.component.handleInput("j");
    harness.component.handleInput("j");
    const text = harness.render();
    expect(text).toContain("Agent graph runs");
    expect(text).toContain("Independent agents");
    expect(plain(text).split("1 live · 1 finished").length - 1).toBe(2);
    expect(text).toContain("\x1b[32m✓\x1b[39m");
    expect(text).toContain("\x1b[32mdone\x1b[39m");
    expect(text).toContain("\x1b[33m×\x1b[39m");
    expect(text).toContain("\x1b[31m●\x1b[39m");
    expect(text).toContain("\x1b[31mrunning\x1b[39m");
    const reversed = harness.lines().filter(line => line.includes("\x1b[7m"));
    expect(reversed).toHaveLength(1);
    const row = reversed[0] ?? "";
    const start = row.indexOf("\x1b[7m") + "\x1b[7m".length;
    const end = row.indexOf("\x1b[27m", start);
    expect(end).toBeGreaterThan(start);
    expect(row.slice(start, end)).not.toMatch(/\x1b\[/);
  });

  it("centers the empty-session copy in a stable body and hides the filter label", () => {
    const empty = setup({ theme: ansiTheme });
    const lines = empty.lines();
    const body = bodyLines(lines);
    expect(body.length).toBeGreaterThanOrEqual(10);
    expect(body.some(line => line.includes("No agents or graph runs in this session yet."))).toBe(true);
    expect(plain(lines[0] ?? "")).not.toContain("filter:");

    const filtered = setup({ theme: ansiTheme });
    filtered.component.handleInput("f");
    expect(plain(filtered.lines()[0] ?? "")).toContain("filter: running");
    expect(plain(filtered.render())).toContain("Agent graph runs");
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
