import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { renderRunningAgentStatus } from "../src/index.js";
import type { AgentRecord, WidgetMode } from "../src/types.js";
import {
  type AgentActivity,
  AgentWidget,
  fgPreservingNestedStyles,
  formatSessionTokens,
  type Theme,
  type UICtx,
} from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
  const ansiTheme = {
    fg: (c: string, s: string) => {
      const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
      return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
    },
    bold: (s: string) => s,
  };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });

  it("preserves the outer style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35m1.2k token (\u001b[33m70%\u001b[39m\u001b[35m)\u001b[39m",
    );
  });
});

describe("renderRunningAgentStatus", () => {
  it("renders running status as separate component lines", () => {
    const theme = { fg: (_c: string, s: string) => s };
    const component = renderRunningAgentStatus("⠋", "thinking: xhigh · 4 tool uses", "thinking…", theme);

    expect(component.render(120).map((line) => line.trimEnd())).toEqual([
      "⠋ thinking: xhigh · 4 tool uses",
      "  ⎿  thinking…",
    ]);
  });
});

describe("AgentWidget", () => {
  const theme: Theme = { fg: (_c, s) => s, bold: (s) => s };

  function makeActivity(overrides: Partial<AgentActivity> = {}): AgentActivity {
    return {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      ...overrides,
    };
  }

  function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
    return {
      id: "agent-1",
      type: "general-purpose",
      description: "agent description",
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      ...overrides,
    };
  }

  type WidgetFactory = Exclude<Parameters<UICtx["setWidget"]>[1], undefined>;

  function harness(
    records: AgentRecord[],
    activities = new Map<string, AgentActivity>(),
    mode?: () => WidgetMode,
  ) {
    const listAgents = vi.fn(() => records);
    const manager = { listAgents } as unknown as AgentManager;
    const setStatus = vi.fn<UICtx["setStatus"]>();
    let widgetFactory: WidgetFactory | undefined;
    const setWidget = vi.fn<UICtx["setWidget"]>((_key, content) => {
      widgetFactory = typeof content === "function" ? content : undefined;
    });
    const requestRender = vi.fn();
    const widget = new AgentWidget(manager, activities, mode);
    widget.setUICtx({ setStatus, setWidget });

    return {
      listAgents,
      requestRender,
      setStatus,
      setWidget,
      widget,
      render(width = 120, renderTheme = theme): string[] {
        if (!widgetFactory) return [];
        return widgetFactory({ terminal: { columns: width }, requestRender }, renderTheme).render();
      },
    };
  }

  it("renders a running agent through the shared two-line summary vocabulary", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(130_000));
      const record = makeRecord({
        description: "run summary",
        startedAt: 65_000,
        compactionCount: 2,
        invocation: {
          modelName: "sonnet",
          thinking: "high",
          isolated: true,
          inheritContext: true,
          runInBackground: true,
          maxTurns: 20,
        },
      });
      const activity = makeActivity({
        activeTools: new Map([["tool-1", "grep"]]),
        toolUses: 3,
        turnCount: 4,
        maxTurns: 20,
        lifetimeUsage: { input: 10_000, output: 2_000, cacheWrite: 345 },
        session: {
          getSessionStats: () => ({
            tokens: { input: 1, output: 1, cacheWrite: 1 },
            contextUsage: { percent: 75 },
          }),
        },
      });
      const h = harness([record], new Map([[record.id, activity]]));

      h.widget.update();

      expect(h.render(240)).toEqual([
        "● Agents",
        "└─ ⠙ Agent (twin) run summary · sonnet · thinking: high · isolated · inherit context · background · max turns: 20 · ↻4≤20 · ⇲2 · 3 tools · 12.3k token (75%) · 1m5s",
        "   └─ searching…",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["completed", "✓ Agent (twin) terminal · 1 tool · 1k · 1m5s"],
    ["steered", "✓ Agent (twin) terminal · 1 tool · 1k · 1m5s · turn limit"],
    ["stopped", "■ Agent (twin) terminal · 1 tool · 1k · 1m5s · stopped"],
    ["aborted", "✗ Agent (twin) terminal · 1 tool · 1k · 1m5s · aborted"],
    ["error", "✗ Agent (twin) terminal · 1 tool · 1k · 1m5s · error: process exited 1"],
  ] as const)("renders %s terminal status through the shared summary", (status, expected) => {
    const record = makeRecord({
      status,
      description: "terminal",
      toolUses: 1,
      startedAt: 1_000,
      completedAt: 66_000,
      lifetimeUsage: { input: 800, output: 200, cacheWrite: 0 },
      error: status === "error" ? "process exited 1\nstack omitted" : undefined,
    });
    const h = harness([record]);

    h.widget.update();

    expect(h.render()).toEqual(["○ Agents", `└─ ${expected}`]);
  });

  it("keeps queued count ahead of finished rows and caps overflow at 12 lines", () => {
    const running = Array.from({ length: 4 }, (_, index) => makeRecord({
      id: `running-${index}`,
      description: `running ${index}`,
    }));
    const queued = Array.from({ length: 3 }, (_, index) => makeRecord({
      id: `queued-${index}`,
      status: "queued",
      description: `queued ${index}`,
    }));
    const finished = Array.from({ length: 3 }, (_, index) => makeRecord({
      id: `finished-${index}`,
      status: "completed",
      description: `finished ${index}`,
      completedAt: Date.now(),
    }));
    const h = harness([...finished, ...queued, ...running]);

    h.widget.update();
    const lines = h.render();

    expect(lines).toHaveLength(12);
    expect(lines.filter((line) => line.includes("running "))).toHaveLength(4);
    expect(lines.findIndex((line) => line.includes("3 queued"))).toBe(9);
    expect(lines[10]).toContain("finished 0");
    expect(lines[11]).toBe("└─ +2 more (2 finished)");
    expect(lines.join("\n")).not.toContain("finished 1");
  });

  it("preserves all, background, and off filtering modes", () => {
    const foreground = makeRecord({ id: "foreground", description: "foreground", isBackground: false });
    const background = makeRecord({ id: "background", description: "background", isBackground: true });
    const unflagged = makeRecord({ id: "unflagged", description: "unflagged" });

    const all = harness([foreground, background, unflagged], new Map(), () => "all");
    all.widget.update();
    expect(all.render().join("\n")).toContain("foreground");
    expect(all.render().join("\n")).toContain("background");
    expect(all.render().join("\n")).toContain("unflagged");

    const backgroundOnly = harness([foreground, background, unflagged], new Map(), () => "background");
    backgroundOnly.widget.update();
    expect(backgroundOnly.render().join("\n")).not.toContain("foreground");
    expect(backgroundOnly.render().join("\n")).toContain("background");
    expect(backgroundOnly.render().join("\n")).toContain("unflagged");

    const off = harness([background], new Map(), () => "off");
    off.widget.update();
    expect(off.render()).toEqual([]);
  });

  it("keeps ANSI and CJK summaries within narrow and wide terminal widths", () => {
    const ansiTheme: Theme = {
      fg: (color, text) => `\u001b[${color === "error" ? 31 : 35}m${text}\u001b[0m`,
      bold: (text) => `\u001b[1m${text}\u001b[0m`,
    };
    const record = makeRecord({
      description: "修复界面🧪 e\u0301 " + "界".repeat(80),
      invocation: { modelName: "模型", thinking: "xhigh" },
      compactionCount: 3,
    });
    const activity = makeActivity({
      responseText: "分析结果界".repeat(20),
      toolUses: 12,
      turnCount: 5,
      maxTurns: 30,
      lifetimeUsage: { input: 1_000_000, output: 200_000, cacheWrite: 34_567 },
    });
    const h = harness([record], new Map([[record.id, activity]]));
    h.widget.update();

    for (const width of [8, 20, 40, 80, 120]) {
      const lines = h.render(width, ansiTheme);
      expect(lines.length).toBeLessThanOrEqual(12);
      for (const line of lines) {
        expect(visibleWidth(line), `width ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps completed and error linger windows unchanged", () => {
    const completed = makeRecord({ status: "completed", completedAt: Date.now() });
    const completedHarness = harness([completed]);
    completedHarness.widget.markFinished(completed.id);
    completedHarness.widget.update();
    expect(completedHarness.render()).not.toEqual([]);
    completedHarness.widget.onTurnStart();
    expect(completedHarness.render()).toEqual([]);

    const failed = makeRecord({ id: "failed", status: "error", completedAt: Date.now(), error: "boom" });
    const failedHarness = harness([failed]);
    failedHarness.widget.markFinished(failed.id);
    failedHarness.widget.update();
    failedHarness.widget.onTurnStart();
    expect(failedHarness.render().join("\n")).toContain("error: boom");
    failedHarness.widget.onTurnStart();
    expect(failedHarness.render()).toEqual([]);
  });

  it("registers once, bounds status churn, owns its 80ms timer, and fully disposes", () => {
    vi.useFakeTimers();
    try {
      const record = makeRecord();
      const h = harness([record]);
      h.widget.ensureTimer();
      h.widget.update();
      h.render();

      h.widget.update();
      h.widget.update();

      expect(h.setWidget.mock.calls.filter((call) => typeof call[1] === "function")).toHaveLength(1);
      expect(h.setStatus).toHaveBeenCalledTimes(1);
      expect(h.setStatus).toHaveBeenLastCalledWith("subagents", "1 running agent");

      const readsBeforeTick = h.listAgents.mock.calls.length;
      vi.advanceTimersByTime(79);
      expect(h.listAgents).toHaveBeenCalledTimes(readsBeforeTick);
      vi.advanceTimersByTime(1);
      expect(h.listAgents).toHaveBeenCalledTimes(readsBeforeTick + 1);

      const rendersBeforeDispose = h.requestRender.mock.calls.length;
      const readsBeforeDispose = h.listAgents.mock.calls.length;
      h.widget.dispose();

      expect(h.setWidget).toHaveBeenLastCalledWith("agents", undefined);
      expect(h.setStatus).toHaveBeenLastCalledWith("subagents", undefined);
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(240);
      expect(h.requestRender).toHaveBeenCalledTimes(rendersBeforeDispose);
      expect(h.listAgents).toHaveBeenCalledTimes(readsBeforeDispose);
    } finally {
      vi.useRealTimers();
    }
  });
});
