import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";

// ── Mock wrapTextWithAnsi ──────────────────────────────────────────────
// We need to control what wrapTextWithAnsi returns to simulate the
// upstream bug (returning lines wider than requested width).
// vi.mock is hoisted and intercepts before conversation-viewer.ts binds
// its import.

let wrapOverride: ((text: string, width: number) => string[]) | null = null;

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const original = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return {
    ...original,
    wrapTextWithAnsi: (...args: [string, number]) => {
      if (wrapOverride) return wrapOverride(...args);
      return original.wrapTextWithAnsi(...args);
    },
  };
});

// Must import AFTER vi.mock declaration (vitest hoists vi.mock but the
// dynamic import of the test subject must happen after)
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { ConversationViewer } = await import("../src/ui/conversation-viewer.js");

// ── Helpers ────────────────────────────────────────────────────────────

function mockTui(rows = 40, columns = 80) {
  return {
    terminal: { rows, columns },
    requestRender: vi.fn(),
  } as any;
}

function mockSession(messages: any[] = []) {
  return {
    messages,
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  } as any;
}

function mockRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "test-1",
    type: "general-purpose",
    description: "test agent",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    ...overrides,
  } as AgentRecord;
}

function ansiTheme() {
  return {
    fg: (_color: string, text: string) => `\x1b[38;5;240m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as any;
}

function assertAllLinesFit(lines: string[], width: number) {
  for (let i = 0; i < lines.length; i++) {
    const vw = visibleWidth(lines[i]);
    expect(vw, `line ${i} exceeds width (${vw} > ${width}): ${JSON.stringify(lines[i])}`).toBeLessThanOrEqual(width);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  wrapOverride = null;
});

describe("ConversationViewer", () => {
  describe("render width safety", () => {
    const widths = [40, 80, 120, 216];

    it("no line exceeds width with empty messages", () => {
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession([]), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with plain text messages", () => {
      const messages = [
        { role: "user", content: "Hello, how are you?" },
        { role: "assistant", content: [{ type: "text", text: "I am fine, thank you for asking." }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("keeps bordered rows exact-width at a double-width truncation boundary", () => {
      const width = 40;
      for (let prefixLength = 0; prefixLength < width; prefixLength++) {
        const viewer = new ConversationViewer(
          mockTui(30, width),
          mockSession([]),
          mockRecord({ description: `${"a".repeat(prefixLength)}界more` }),
          undefined,
          ansiTheme(),
          vi.fn(),
        );

        for (const line of viewer.render(width)) {
          expect(
            visibleWidth(line),
            `prefix ${prefixLength} produced an under-width bordered row: ${JSON.stringify(line)}`,
          ).toBe(width);
        }
      }
    });

    it("no line exceeds width when text is longer than viewport", () => {
      const longLine = "A".repeat(500);
      const messages = [
        { role: "user", content: longLine },
        { role: "assistant", content: [{ type: "text", text: longLine }] },
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: longLine }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with embedded ANSI escape codes in content", () => {
      const ansiText = `\x1b[1mBold heading\x1b[22m and \x1b[31mred text\x1b[0m ${"X".repeat(300)}`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: ansiText }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with long URLs", () => {
      const url = "https://example.com/" + "a/b/c/d/e/".repeat(30) + "?q=" + "x".repeat(100);
      const messages = [
        { role: "assistant", content: [{ type: "text", text: `Check this link: ${url}` }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with wide table-like content", () => {
      const header = "| " + Array.from({ length: 20 }, (_, i) => `Column${i}`).join(" | ") + " |";
      const dataRow = "| " + Array.from({ length: 20 }, () => "value123").join(" | ") + " |";
      const table = [header, dataRow, dataRow, dataRow].join("\n");
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: table }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with bashExecution messages", () => {
      const messages = [
        {
          role: "bashExecution", command: "cat " + "/very/long/path/".repeat(20) + "file.txt",
          output: "O".repeat(600),
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with running activity indicator", () => {
      const activity = {
        activeTools: new Map([["read", "file.ts"], ["grep", "pattern"]]),
        toolUses: 5, tokens: "10k", responseText: "R".repeat(400),
        session: { getSessionStats: () => ({ tokens: { total: 50000 } }) },
      };
      const messages = [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [{ type: "text", text: "working on it" }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord({ status: "running" }), activity as any, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with tool calls", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check that." },
            { type: "toolCall", toolUseId: "t1", name: "very_long_tool_name_" + "x".repeat(200), input: {} },
          ],
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width at narrow terminal", () => {
      const messages = [
        { role: "user", content: "Hello world, this is a normal sentence." },
        { role: "assistant", content: [{ type: "text", text: "Sure, here's the answer." }] },
      ];
      for (const w of [8, 10, 15, 20]) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with mixed ANSI + unicode content", () => {
      const text = `\x1b[32m✓\x1b[0m Test passed — 日本語テスト ${"あ".repeat(50)} \x1b[33m⚠\x1b[0m`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });

  describe("safety net against upstream wrapTextWithAnsi bugs", () => {
    // These tests call buildContentLines() directly (via the private method)
    // because render() has its own truncation via row(). The safety net in
    // buildContentLines is what prevents the TUI crash — it must clamp
    // independently of render().

    /** Call the private buildContentLines method directly. */
    function callBuildContentLines(viewer: InstanceType<typeof ConversationViewer>, width: number): string[] {
      return (viewer as any).buildContentLines(width);
    }

    it("mock is intercepting wrapTextWithAnsi", async () => {
      const { wrapTextWithAnsi } = await import("@earendil-works/pi-tui");
      wrapOverride = () => ["MOCK_SENTINEL"];
      expect(wrapTextWithAnsi("anything", 10)).toEqual(["MOCK_SENTINEL"]);
      wrapOverride = null;
    });

    it("clamps overwidth lines from toolResult content", () => {
      const w = 80;
      wrapOverride = () => ["X".repeat(w + 50)];

      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from user message content", () => {
      const w = 80;
      wrapOverride = () => ["Y".repeat(w + 100)];

      const messages = [{ role: "user", content: "hello" }];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from assistant message content", () => {
      const w = 80;
      wrapOverride = () => ["Z".repeat(w + 100)];

      const messages = [
        { role: "assistant", content: [{ type: "text", text: "response" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from bashExecution output", () => {
      const w = 80;
      wrapOverride = () => ["B".repeat(w + 100)];

      const messages = [
        {
          role: "bashExecution", command: "ls", output: "out",
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines that also contain ANSI codes", () => {
      const w = 80;
      wrapOverride = () => [`\x1b[1m\x1b[31m${"W".repeat(w + 30)}\x1b[0m`];

      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });
  });

  describe("stop key", () => {
    const W = 80;

    it("two-press x stops a running agent (first arms, second aborts)", () => {
      const onStop = vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      // Idle footer offers the stop affordance.
      expect(viewer.render(W).join("\n")).toContain("x stop");

      // First press arms (no abort yet) and re-renders.
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
      expect(tui.requestRender).toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).toContain("x again to STOP");

      // Second press aborts.
      viewer.handleInput("x");
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("any other key disarms the confirm", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      viewer.handleInput("x");                       // arm
      viewer.handleInput("j");                       // scroll → disarm
      expect(viewer.render(W).join("\n")).toContain("x stop");
      expect(viewer.render(W).join("\n")).not.toContain("x again to STOP");

      viewer.handleInput("x");                       // arms again, does NOT stop
      expect(onStop).not.toHaveBeenCalled();
    });

    it("does not offer or perform stop once the agent is no longer running", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      viewer.handleInput("x");
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
    });

    it("no stop affordance when no onStop handler is provided (read-only history)", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      expect(() => { viewer.handleInput("x"); viewer.handleInput("x"); }).not.toThrow();
    });
  });

  describe("steer composer", () => {
    const W = 80;

    function makeViewer(opts: { status?: AgentRecord["status"]; onSteer?: (m: string) => void } = {}) {
      const onSteer = opts.onSteer ?? vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: opts.status ?? "running" }),
        undefined, ansiTheme(), vi.fn(), undefined, undefined, onSteer,
      );
      return { viewer, tui, onSteer };
    }

    it("offers the steer affordance for a running agent and opens on Enter", () => {
      const { viewer } = makeViewer();
      expect(viewer.render(W).join("\n")).toContain("enter steer");

      viewer.handleInput("\r"); // Enter
      // Composer is shown (its prompt + send/cancel hint), idle footer is gone.
      const out = viewer.render(W).join("\n");
      expect(out).toContain("enter send · esc cancel");
      expect(out).not.toContain("enter steer");
    });

    it("typing then Enter sends the trimmed message and closes the composer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      for (const ch of "  hello  ") viewer.handleInput(ch);
      viewer.handleInput("\r"); // send

      expect(onSteer).toHaveBeenCalledWith("hello");
      expect(viewer.render(W).join("\n")).not.toContain("enter send"); // composer closed
    });

    it("Esc cancels the composer without sending", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      for (const ch of "draft") viewer.handleInput(ch);
      viewer.handleInput("\x1b"); // Esc

      expect(onSteer).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("enter send");
    });

    it("an empty submit just returns (like Esc), without calling onSteer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      viewer.handleInput("\r"); // empty submit
      expect(onSteer).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("enter send"); // composer closed
    });

    it("scroll keys are inert while composing (input owns them)", () => {
      const { viewer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      // 'j' would normally scroll, but here it types into the composer.
      viewer.handleInput("j");
      expect(viewer.render(W).join("\n")).toContain("enter send · esc cancel");
    });

    it("no steer affordance once the agent is no longer running", () => {
      const { viewer, onSteer } = makeViewer({ status: "completed" });
      expect(viewer.render(W).join("\n")).not.toContain("enter steer");
      viewer.handleInput("\r");
      expect(viewer.render(W).join("\n")).not.toContain("enter send");
      expect(onSteer).not.toHaveBeenCalled();
    });

    it("no steer affordance when no onSteer handler is provided", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("enter steer");
      expect(() => viewer.handleInput("\r")).not.toThrow();
    });

    it("composer rows never exceed width", () => {
      for (const w of [40, 80, 120]) {
        const tui = mockTui(30, w);
        const viewer = new ConversationViewer(
          tui, mockSession(), mockRecord({ status: "running" }),
          undefined, ansiTheme(), vi.fn(), undefined, undefined, vi.fn(),
        );
        viewer.handleInput("\r"); // open composer
        for (const ch of "x".repeat(200)) viewer.handleInput(ch);
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });
});

// ── Reworked viewer: frame, header, content, cache, nav, search ──────────

const ANSI_BG = "\x1b[48;5;236m";

function bgTheme() {
  return {
    fg: (_color: string, text: string) => `\x1b[38;5;240m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    getBgAnsi: () => ANSI_BG,
  } as any;
}

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("ConversationViewer — frame and sanitize", () => {
  it("frames through frameOverlay with a titled top border and footer divider", () => {
    const viewer = new ConversationViewer(
      mockTui(30, 92), mockSession([{ role: "user", content: "hi" }]),
      mockRecord({ status: "completed" }), undefined, bgTheme(), vi.fn(),
    );
    const lines = viewer.render(92);
    expect(plain(lines[0] ?? "").startsWith("\u256d")).toBe(true);
    expect(plain(lines[0] ?? "")).toContain("Conversation");
    expect(plain(lines.at(-1) ?? "").startsWith("\u2570")).toBe(true);
    expect(plain(lines.at(-3) ?? "").startsWith("\u251c")).toBe(true);
  });

  it("puts the N lines · P% readout in the title right slot", () => {
    const viewer = new ConversationViewer(
      mockTui(30, 92), mockSession([{ role: "user", content: "hi" }]),
      mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    expect(plain(viewer.render(92)[0] ?? "")).toMatch(/\d+ lines · \d+%/);
  });

  it("strips terminal control sequences from content and fills the background", () => {
    const messages = [{ role: "user", content: "\x1b[2J\x1b[31mred\x1b[m" }];
    const viewer = new ConversationViewer(
      mockTui(30, 80), mockSession(messages), mockRecord({ status: "completed" }),
      undefined, bgTheme(), vi.fn(),
    );
    const lines = viewer.render(80);
    const joined = lines.join("\n");
    expect(joined).not.toContain("\x1b[2J");
    expect(joined).toContain("red");
    for (const line of lines) expect(line.startsWith(ANSI_BG)).toBe(true);
  });

  it("never renders more rows than the viewport cap in any footer mode", () => {
    const rows = 30;
    const cap = Math.floor((rows * 70) / 100);
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `line ${i}` }));
    const live = { session: {} as any }; // record.session defined → no history invocation row

    // normal
    const v1 = new ConversationViewer(
      mockTui(rows, 92), mockSession(messages), mockRecord({ status: "running", ...live }),
      undefined, ansiTheme(), vi.fn(), vi.fn(), undefined, vi.fn(),
    );
    expect(v1.render(92).length).toBeLessThanOrEqual(cap);
    // composer
    v1.handleInput("\r");
    expect(v1.render(92).length).toBeLessThanOrEqual(cap);
    v1.dispose();

    // search input
    const v2 = new ConversationViewer(
      mockTui(rows, 92), mockSession(messages), mockRecord({ status: "completed", ...live }),
      undefined, ansiTheme(), vi.fn(),
    );
    v2.render(92);
    v2.handleInput("/");
    expect(v2.render(92).length).toBeLessThanOrEqual(cap);

    // history (invocation row; record.session undefined)
    const v3 = new ConversationViewer(
      mockTui(rows, 92), mockSession(messages),
      mockRecord({ status: "completed", invocation: { modelName: "claude" } as any }),
      undefined, ansiTheme(), vi.fn(),
    );
    expect(v3.render(92).length).toBeLessThanOrEqual(cap);
  });
});

describe("ConversationViewer — header", () => {
  it("renders status word, glyph, stat parts, and read-only history tag", () => {
    const activity = {
      activeTools: new Map(), toolUses: 7, responseText: "", turnCount: 0,
      lifetimeUsage: { input: 81_200, output: 0, cacheWrite: 0 },
      session: { getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: 62 } }) },
    };
    const viewer = new ConversationViewer(
      mockTui(30, 92), mockSession([{ role: "user", content: "hi" }]),
      mockRecord({ status: "completed", description: "fix auth tests", startedAt: 1_000, completedAt: 43_300, invocation: { modelName: "claude-sonnet-4-5" } as any }),
      activity as any, ansiTheme(), vi.fn(),
    );
    const out = plain(viewer.render(92).join("\n"));
    expect(out).toContain("done"); // completed → word
    expect(out).toContain("fix auth tests");
    expect(out).toContain("7 tools");
    expect(out).toContain("42.3s");
    expect(out).toContain("81.2k token");
    expect(out).toContain("62%");
    expect(out).toContain("claude-sonnet-4-5");
    expect(out).toContain("history · read-only");
  });
});

describe("ConversationViewer — content blocks", () => {
  it("collapses long tool results to head/ellipsis/tail with an error marker", () => {
    wrapOverride = (t) => t.split("\n");
    const body = Array.from({ length: 20 }, (_, i) => `row ${i}`).join("\n");
    const messages = [{ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: body }] }];
    const viewer = new ConversationViewer(
      mockTui(40, 100), mockSession(messages), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    const out = plain(viewer.render(100).join("\n"));
    expect(out).toContain("[Result: bash]");
    expect(out).toContain("error");
    expect(out).toContain("row 0");
    expect(out).toContain("row 19");
    expect(out).toContain("… +11 lines");
    expect(out).not.toContain("row 10");
  });

  it("shows (no output) for an empty tool result", () => {
    const messages = [{ role: "toolResult", toolName: "read", isError: false, content: [] }];
    const viewer = new ConversationViewer(
      mockTui(40, 100), mockSession(messages), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    const out = plain(viewer.render(100).join("\n"));
    expect(out).toContain("[Result: read]");
    expect(out).toContain("(no output)");
  });

  it("renders a compaction block with head-only budget", () => {
    wrapOverride = (t) => t.split("\n");
    const summary = Array.from({ length: 12 }, (_, i) => `s${i}`).join("\n");
    const messages = [{ role: "compactionSummary", summary, tokensBefore: 50_000 }];
    const viewer = new ConversationViewer(
      mockTui(40, 100), mockSession(messages), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    const out = plain(viewer.render(100).join("\n"));
    expect(out).toContain("compacted · 50.0k token summarized");
    expect(out).toContain("s0");
    expect(out).toContain("s2");
    expect(out).toContain("… +9 lines");
    expect(out).not.toContain("s3");
  });

  it("previews the first meaningful tool argument", () => {
    const messages = [{
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        { type: "toolCall", id: "t1", name: "bash", arguments: { command: "pnpm test" } },
      ],
    }];
    const viewer = new ConversationViewer(
      mockTui(30, 92), mockSession(messages), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    const out = plain(viewer.render(92).join("\n"));
    expect(out).toContain("[Tool: bash]");
    expect(out).toContain("pnpm test");
  });

  it("shows a thinking annotation and streaming assistant text", () => {
    const activity = {
      activeTools: new Map(), toolUses: 0, responseText: "streaming answer here", turnCount: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    };
    const messages = [{ role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(1400) }, { type: "text", text: "earlier reply" }] }];
    const viewer = new ConversationViewer(
      mockTui(30, 92), mockSession(messages), mockRecord({ status: "running" }), activity as any, ansiTheme(), vi.fn(),
    );
    const out = plain(viewer.render(92).join("\n"));
    expect(out).toContain("(thinking · 1.4k chars)");
    expect(out).toContain("streaming answer here");
    viewer.dispose();
  });

  it("shows the empty-state line", () => {
    const running = new ConversationViewer(
      mockTui(30, 92), mockSession([]), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
    );
    expect(plain(running.render(92).join("\n"))).toContain("waiting for first message");
    running.dispose();
    const done = new ConversationViewer(
      mockTui(30, 92), mockSession([]), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    expect(plain(done.render(92).join("\n"))).toContain("No messages recorded.");
  });

  it("surfaces assistant stop reasons and skips assistants with nothing to show", () => {
    const messages = [
      { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit exceeded" },
      { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" },
      { role: "assistant", content: [{ type: "text", text: "long" }], stopReason: "length" },
      { role: "assistant", content: [], stopReason: "stop" },
    ];
    const viewer = new ConversationViewer(
      mockTui(40, 100), mockSession(messages), mockRecord({ status: "error" }), undefined, ansiTheme(), vi.fn(),
    );
    const out = plain(viewer.render(100).join("\n"));
    expect(out).toContain("× error: 429 rate limit exceeded");
    expect(out).toContain("■ aborted");
    expect(out).toContain("⚠ stopped at output limit");
    expect(out.match(/\[Assistant\]/g)).toHaveLength(3);
    expect(out).toContain("× failed");
  });

  it("renders image placeholders, with a bare label when the mime type is unknown", () => {
    const messages = [
      { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] },
      { role: "toolResult", toolName: "read", isError: false, content: [{ type: "image", data: "x" }] },
    ];
    const viewer = new ConversationViewer(
      mockTui(40, 100), mockSession(messages), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    const out = plain(viewer.render(100).join("\n"));
    expect(out).toContain("[User]");
    expect(out).toContain("[image: image/png]");
    expect(out).toContain("[image]");
    expect(out).not.toContain("[image: ]");
  });

  it("labels a result without a tool name as [Result]", () => {
    const messages = [{ role: "toolResult", isError: false, content: [{ type: "text", text: "ok" }] }];
    const viewer = new ConversationViewer(
      mockTui(40, 100), mockSession(messages), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    const out = plain(viewer.render(100).join("\n"));
    expect(out).toContain("[Result]");
    expect(out).not.toContain("[Result: ]");
  });

  it("renders summaries, displayed custom messages, and shell command outcomes", () => {
    const messages = [
      { role: "branchSummary", summary: "branch notes", fromId: "x" },
      { role: "custom", customType: "steer-note", content: "Focus on tests", display: true },
      { role: "custom", customType: "hidden-note", content: "secret", display: false },
      { role: "bashExecution", command: "pnpm lint", output: "boom", exitCode: 1, cancelled: false, truncated: false },
      { role: "bashExecution", command: "sleep 9", output: "", exitCode: undefined, cancelled: true, truncated: false },
    ];
    const viewer = new ConversationViewer(
      mockTui(40, 100), mockSession(messages), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    const out = plain(viewer.render(100).join("\n"));
    expect(out).toContain("── branch summary ──");
    expect(out).toContain("branch notes");
    expect(out).toContain("[steer-note]");
    expect(out).toContain("Focus on tests");
    expect(out).not.toContain("secret");
    expect(out).toContain("$ pnpm lint × exit 1");
    expect(out).toContain("$ sleep 9 ■ cancelled");
  });

  it("does not duplicate the finished assistant message as a streaming block", () => {
    const activity = {
      activeTools: new Map(), toolUses: 0, responseText: "final answer", turnCount: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    };
    const messages = [{ role: "assistant", content: [{ type: "text", text: "final answer" }] }];
    const viewer = new ConversationViewer(
      mockTui(30, 92), mockSession(messages), mockRecord({ status: "running" }), activity as any, ansiTheme(), vi.fn(),
    );
    const out = plain(viewer.render(92).join("\n"));
    expect(out.match(/final answer/g)).toHaveLength(1);
    viewer.dispose();
  });

  it("drops control characters that could move the cursor or reset the terminal", () => {
    const messages = [{ role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "a\x07b\x08c\x1bcd\r\ne" }] }];
    const viewer = new ConversationViewer(
      mockTui(30, 80), mockSession(messages), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    const joined = viewer.render(80).join("\n");
    expect(joined).not.toContain("\x07");
    expect(joined).not.toContain("\x08");
    expect(joined).not.toContain("\x1bc");
    expect(joined).not.toContain("\r");
    expect(plain(joined)).toContain("abccd"); // the ESC of "\x1bc" is dropped; the printable "c" stays
  });
});

describe("ConversationViewer — cache and scroll", () => {
  it("does not re-wrap on repeat render or on scroll input", () => {
    const messages = [
      { role: "user", content: "hello world" },
      { role: "assistant", content: [{ type: "text", text: "a response here" }] },
    ];
    const viewer = new ConversationViewer(
      mockTui(30, 80), mockSession(messages), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    viewer.render(80); // build cache
    let calls = 0;
    wrapOverride = (t) => { calls++; return [t]; };
    viewer.render(80);
    expect(calls).toBe(0);
    viewer.handleInput("k");
    expect(calls).toBe(0);
  });

  it("clamps scrollOffset in render after content shrinks", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `line ${i}` }));
    const viewer = new ConversationViewer(
      mockTui(16, 80), mockSession(messages), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    viewer.render(80);
    (viewer as any).scrollOffset = 9999;
    (viewer as any).autoScroll = false;
    viewer.render(80);
    const max = Math.max(0, (viewer as any).contentLines.length - (viewer as any).viewportHeight());
    expect((viewer as any).scrollOffset).toBeLessThanOrEqual(max);
  });
});

describe("ConversationViewer — jump and search", () => {
  it("jumps between block starts with [ and ]", () => {
    wrapOverride = (t) => t.split("\n");
    const messages = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
      { role: "user", content: "third" },
    ];
    const viewer = new ConversationViewer(
      mockTui(16, 80), mockSession(messages), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    const jump = (k: string) => { viewer.handleInput(k); viewer.render(80); return (viewer as any).scrollOffset; };
    viewer.render(80);
    expect(jump("[")).toBe(3);
    expect(jump("[")).toBe(0);
    expect(jump("]")).toBe(3);
  });

  it("searches, navigates matches, and clears on esc", () => {
    wrapOverride = (t) => t.split("\n");
    const messages = [
      { role: "user", content: "alpha" },
      { role: "user", content: "beta reject" },
      { role: "user", content: "gamma reject" },
    ];
    const viewer = new ConversationViewer(
      mockTui(30, 92), mockSession(messages), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    viewer.render(92);
    viewer.handleInput("/");
    for (const ch of "reject") viewer.handleInput(ch);
    let out = plain(viewer.render(92).join("\n"));
    expect(out).toContain("⌕ search");
    expect(out).toContain("2 matches");
    viewer.handleInput("\r"); // confirm
    out = plain(viewer.render(92).join("\n"));
    expect(out).toContain('"reject"');
    expect(out).toContain("1/2");
    viewer.handleInput("n"); // next
    out = plain(viewer.render(92).join("\n"));
    expect(out).toContain("2/2");
    viewer.handleInput("\x1b"); // clear confirmed search
    out = plain(viewer.render(92).join("\n"));
    expect(out).not.toContain('"reject"');
    expect(out).toContain("esc close");
  });

  it("empty search Enter cancels and restores scroll", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `line ${i}` }));
    const viewer = new ConversationViewer(
      mockTui(16, 80), mockSession(messages), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    viewer.render(80);
    const before = (viewer as any).scrollOffset;
    viewer.handleInput("/");
    viewer.handleInput("\r"); // empty submit cancels
    viewer.render(80);
    expect((viewer as any).scrollOffset).toBe(before);
    expect(plain(viewer.render(80).join("\n"))).toContain("esc close");
  });

  it("highlights matches while typing, before the search is confirmed", () => {
    wrapOverride = (t) => t.split("\n");
    const messages = [{ role: "user", content: "beta reject" }];
    const viewer = new ConversationViewer(
      mockTui(30, 92), mockSession(messages), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    viewer.render(92);
    viewer.handleInput("/");
    for (const ch of "reject") viewer.handleInput(ch);
    // The unit pi-tui stub's truncateToWidth strips styling inside framed rows, so assert the
    // highlight is applied before framing rather than reading escape codes from the frame.
    const highlight = vi.spyOn(viewer as any, "highlightMatches");
    viewer.render(92);
    expect(highlight).toHaveBeenCalledWith("beta reject", "reject");
    expect(highlight.mock.results.some(r => r.value === "beta \x1b[7mreject\x1b[27m")).toBe(true);
  });
});

describe("ConversationViewer — live timer", () => {
  it("ticks requestRender while running and stops when terminal", () => {
    vi.useFakeTimers();
    try {
      const tui = mockTui(30, 80);
      const record = mockRecord({ status: "running" });
      const viewer = new ConversationViewer(tui, mockSession(), record, undefined, ansiTheme(), vi.fn());
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);
      expect(tui.requestRender).toHaveBeenCalledTimes(2);
      record.status = "completed";
      vi.advanceTimersByTime(1000); // tick sees terminal → clears, no render
      const after = tui.requestRender.mock.calls.length;
      vi.advanceTimersByTime(5000);
      expect(tui.requestRender.mock.calls.length).toBe(after);
      viewer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never requests render after dispose", () => {
    vi.useFakeTimers();
    try {
      const tui = mockTui(30, 80);
      const viewer = new ConversationViewer(tui, mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn());
      viewer.dispose();
      vi.advanceTimersByTime(5000);
      expect(tui.requestRender).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
