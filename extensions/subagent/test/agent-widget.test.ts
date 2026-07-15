import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWidget, formatTokens, formatTurns, formatStatusParts, formatMs, formatDuration, describeActivity } from "../src/ui/agent-widget.js";

// Status formatters now emit ASCII-ish glyphs (↻ turns, plain "N tools",
// compact token magnitudes). The legacy Nerd Font literals (󰾆/󱁤) survive only
// as opaque inputs to the formatStatusParts join test below.


afterEach(() => {
  vi.useRealTimers();
});
describe("formatTokens", () => {
  it("formats millions with M suffix", () => {
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });

  it("formats exactly 1M", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
  });

  it("formats thousands with k suffix", () => {
    expect(formatTokens(33_800)).toBe("33.8k");
  });

  it("formats exactly 1k", () => {
    expect(formatTokens(1_000)).toBe("1k");
  });

  it("formats small counts without suffix", () => {
    expect(formatTokens(500)).toBe("500");
  });

  it("formats zero", () => {
    expect(formatTokens(0)).toBe("0");
  });
});

describe("formatTurns", () => {
  it("formats turn count", () => {
    expect(formatTurns(5)).toBe("↻5");
  });

  it("includes max turns with ≤ separator", () => {
    expect(formatTurns(5, 30)).toBe("↻5≤30");
  });

  it("omits max when null", () => {
    expect(formatTurns(3, null)).toBe("↻3");
  });

  it("omits max when undefined", () => {
    expect(formatTurns(3, undefined)).toBe("↻3");
  });

  it("handles zero turns", () => {
    expect(formatTurns(0)).toBe("↻0");
  });

  it("handles turn count equal to max", () => {
    expect(formatTurns(50, 50)).toBe("↻50≤50");
  });
});

describe("formatStatusParts", () => {
  it("joins stats without spaces around separators", () => {
    expect(formatStatusParts(["github-copilot/claude-haiku-4.5", "⟳ 9", "󱁤 28", "󰾆 274.3k"])).toBe("github-copilot/claude-haiku-4.5·⟳ 9·󱁤 28·󰾆 274.3k");
  });
});

describe("formatMs", () => {
  it("converts milliseconds to seconds", () => {
    expect(formatMs(5700)).toBe("5.7s");
  });

  it("handles sub-second", () => {
    expect(formatMs(300)).toBe("0.3s");
  });

  it("handles zero", () => {
    expect(formatMs(0)).toBe("0.0s");
  });

  it("handles large values", () => {
    expect(formatMs(125_400)).toBe("125.4s");
  });
});

describe("formatDuration", () => {
  it("uses completedAt when provided", () => {
    expect(formatDuration(1000, 6700)).toBe("5.7s");
  });

  it("shows (running) suffix when no completedAt", () => {
    const result = formatDuration(Date.now() - 3000);
    expect(result).toMatch(/^\d+\.\ds \(running\)$/);
  });
});

describe("describeActivity", () => {
  it("returns thinking… with no tools and no text", () => {
    expect(describeActivity(new Map())).toBe("thinking…");
  });

  it("describes a single active tool", () => {
    const tools = new Map([["call-1", "read"]]);
    expect(describeActivity(tools)).toBe("reading…");
  });

  it("groups multiple calls of same tool", () => {
    const tools = new Map([["c1", "read"], ["c2", "read"], ["c3", "read"]]);
    expect(describeActivity(tools)).toBe("reading 3 files…");
  });

  it("groups searching with patterns label", () => {
    const tools = new Map([["c1", "grep"], ["c2", "grep"]]);
    expect(describeActivity(tools)).toBe("searching 2 patterns…");
  });

  it("joins multiple tool types", () => {
    const tools = new Map([["c1", "read"], ["c2", "edit"]]);
    expect(describeActivity(tools)).toBe("reading, editing…");
  });

  it("shows truncated response text when no tools active", () => {
    const result = describeActivity(new Map(), "I found the issue in auth.ts");
    expect(result).toBe("I found the issue in auth.ts");
  });

  it("uses unknown tool name verbatim", () => {
    const tools = new Map([["c1", "custom_tool"]]);
    expect(describeActivity(tools)).toBe("custom_tool…");
  });
});

describe("AgentWidget render scheduling", () => {
  it("does not keep the process alive with its render timer and still clears it on dispose", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const widget = new AgentWidget({ listAgents: () => [] } as never, new Map());

    widget.ensureTimer();
    const timer = (widget as unknown as { widgetInterval: NodeJS.Timeout }).widgetInterval;
    const keptProcessAlive = timer.hasRef();
    widget.dispose();

    expect(keptProcessAlive).toBe(false);
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    clearIntervalSpy.mockRestore();
  });

  it("does not request another render when active agent state is unchanged before the animation cadence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const record = {
      id: "agent-1",
      type: "general-purpose",
      status: "running",
      description: "Investigate blinking",
      toolUses: 0,
      startedAt: 0,
    };
    const manager = { listAgents: vi.fn(() => [record]) };
    const widget = new AgentWidget(manager as never, new Map());
    const uiCtx = {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };

    widget.setUICtx(uiCtx);
    widget.update();

    const widgetFactory = uiCtx.setWidget.mock.calls[0][1];
    const tui = { terminal: { columns: 120 }, requestRender: vi.fn() };
    const theme = { fg: vi.fn((_color: string, text: string) => text), bold: vi.fn((text: string) => text) };
    widgetFactory(tui, theme).render();

    widget.update();
    expect(tui.requestRender).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    widget.update();
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("suspends animation repaints while an overlay owns the screen, and resumes after", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const record = {
      id: "agent-1",
      type: "general-purpose",
      status: "running",
      description: "Investigate blinking",
      toolUses: 0,
      startedAt: 0,
    };
    const manager = { listAgents: vi.fn(() => [record]) };
    const widget = new AgentWidget(manager as never, new Map());
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };

    widget.setUICtx(uiCtx);
    widget.update();

    const widgetFactory = uiCtx.setWidget.mock.calls[0][1];
    const tui = { terminal: { columns: 120 }, requestRender: vi.fn() };
    const theme = { fg: vi.fn((_color: string, text: string) => text), bold: vi.fn((text: string) => text) };
    widgetFactory(tui, theme).render();

    // Overlay opens: suspend. Even after the animation cadence, no repaint.
    widget.suspend();
    vi.advanceTimersByTime(250);
    widget.update();
    expect(tui.requestRender).not.toHaveBeenCalled();

    // Overlay closes: resume forces exactly one repaint.
    widget.resume();
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });
});

describe("AgentWidget idle coloring", () => {
  function renderRunning(lastProgressAt: number): string[] {
    const record = {
      id: "a1",
      type: "general-purpose",
      status: "running",
      description: "Investigate",
      toolUses: 0,
      startedAt: Date.now(),
    };
    const activity = {
      activeTools: new Map<string, string>(),
      toolUses: 0,
      tokens: "",
      responseText: "",
      turnCount: 1,
      lastProgressAt,
    };
    const manager = { listAgents: vi.fn(() => [record]) };
    const widget = new AgentWidget(manager as never, new Map([["a1", activity as never]]));
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    widget.setUICtx(uiCtx);
    widget.update();
    const widgetFactory = uiCtx.setWidget.mock.calls[0][1];
    const tui = { terminal: { columns: 200 }, requestRender: vi.fn() };
    const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (t: string) => t };
    return widgetFactory(tui, theme).render();
  }

  it("colors a fresh running agent's row accent", () => {
    const lines = renderRunning(Date.now());
    const header = lines.find(l => l.includes("Investigate"));
    expect(header).toContain("<accent>");
  });

  it("dims a running agent's row after the idle threshold", () => {
    const lines = renderRunning(Date.now() - 61_000);
    const header = lines.find(l => l.includes("Investigate"));
    expect(header).toBeDefined();
    expect(header).not.toContain("<accent>");
  });
});
