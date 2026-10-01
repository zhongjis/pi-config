import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFooterVisuals } from "../src/footer.js";

type FooterComponent = { dispose(): void; render(width: number): string[] };
type FooterFactory = (
  tui: { requestRender(): void },
  theme: { fg(color: string, text: string): string; getThinkingBorderColor(level: string): () => string },
  footerData: {
    onBranchChange(callback: () => void): () => void;
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
    getAvailableProviderCount(): number;
  },
) => FooterComponent;
type EventPayload = {
  message?: ReturnType<typeof assistant> | { role: "user" | "toolResult" };
  assistantMessageEvent?: { type: string; delta?: string };
};
type EventHandler = (event: EventPayload, ctx: unknown) => Promise<void> | void;

function assistant(output: number, stopReason = "stop") {
  return { role: "assistant", stopReason, usage: { output } };
}

function createHarness() {
  const handlers = new Map<string, EventHandler>();
  let footerFactory: FooterFactory | undefined;
  const historicalEntries = [{
    type: "message",
    timestamp: "1970-01-01T00:00:00.000Z",
    message: {
      ...assistant(999),
      usage: { input: 0, output: 999, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    },
  }];
  const ctx = {
    hasUI: true,
    cwd: "/workspace",
    model: { id: "model", provider: "provider", reasoning: false },
    modelRegistry: { isUsingOAuth: () => false },
    isIdle: () => true,
    getContextUsage: () => ({ contextWindow: 200_000, percent: 0 }),
    hasPendingMessages: () => false,
    compact: () => {},
    sessionManager: {
      getEntries: () => historicalEntries,
      getSessionName: () => undefined,
    },
    ui: {
      setFooter(factory: FooterFactory): void {
        footerFactory = factory;
      },
    },
  };
  const pi = {
    getThinkingLevel: () => "off",
    on(event: string, handler: EventHandler): void {
      handlers.set(event, handler);
    },
  };

  installFooterVisuals(pi as never);

  const emit = async (event: string, payload: EventPayload = {}) => {
    await handlers.get(event)?.(payload, ctx);
  };
  const styles: [string, string][] = [];
  const footer = (width = 200) => {
    if (!footerFactory) throw new Error("footer was not installed");
    return footerFactory(
      { requestRender(): void {} },
      { fg: (color, text) => { styles.push([color, text]); return text; }, getThinkingBorderColor: () => () => "" },
      {
        onBranchChange: () => () => {},
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 1,
      },
    )
      .render(width)
      .join("\n");
  };

  const update = (type = "text_delta", delta = "output") => emit("message_update", {
    message: assistant(1), assistantMessageEvent: { type, delta },
  });
  return { emit, update, footer, styles, ctx };
}

describe("qol footer generation TPS", () => {
  let now = 0;

  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-visuals:footer")];
  });

  it.each(["text_delta", "thinking_delta", "toolcall_delta"])("times the first nonempty %s, excluding waiting, history and tool execution", async (type) => {
    const { emit, update, footer } = createHarness();
    await emit("session_start");
    expect(footer()).not.toContain("tok/s");

    now = 100;
    await emit("turn_start");
    await emit("before_provider_request");
    await emit("message_start", { message: assistant(0) });
    now = 10_100;
    await update(type);
    now = 11_100;
    await update();
    now = 12_100;
    await emit("message_end", { message: assistant(200) });
    expect(footer()).toContain("100 tok/s");

    now = 13_000;
    await emit("tool_execution_start");
    now = 19_000;
    await emit("tool_execution_end");
    await emit("turn_start");
    await emit("before_provider_request");
    now = 21_000;
    await update(type);
    expect(footer()).toContain("100 tok/s");
    now = 23_000;
    await emit("message_end", { message: assistant(100, "toolUse") });
    expect(footer()).toContain("50.0 tok/s");
  });

  it("ignores empty deltas and metadata updates", async () => {
    const { emit, update, footer } = createHarness();
    await emit("session_start");
    await emit("before_provider_request");
    for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) await update(type, "");
    for (const type of ["start", "text_start", "thinking_start", "toolcall_start", "text_end", "thinking_end", "toolcall_end"]) {
      await update(type);
    }
    now = 10_000;
    await update("thinking_delta", " ");
    now = 11_000;
    await emit("message_end", { message: assistant(100) });
    expect(footer()).toContain("100 tok/s");
  });

  it("excludes failed streams and retry backoff from successful generation", async () => {
    const { emit, update, footer } = createHarness();
    await emit("session_start");
    await emit("turn_start");
    await emit("before_provider_request");
    await emit("message_start", { message: assistant(0) });
    await update();
    now = 1_000;
    await emit("message_end", { message: assistant(100, "error") });
    expect(footer()).not.toContain("tok/s");
    await emit("auto_retry_start");
    now = 10_000;
    await emit("turn_start");
    await emit("before_provider_request");
    await emit("message_start", { message: assistant(0) });
    now = 12_000;
    await update();
    now = 13_000;
    await emit("message_end", { message: assistant(40) });
    expect(footer()).toContain("40.0 tok/s");
  });

  it.each(["turn_start", "before_provider_request", "message_start"])("discards unfinished timing on %s without clearing the completed rate", async (boundary) => {
    const { emit, update, footer } = createHarness();
    await emit("session_start");
    await update();
    now = 1_000;
    await emit("message_end", { message: assistant(100) });
    await update();
    now = 10_000;
    await emit(boundary, { message: assistant(0) });
    expect(footer()).toContain("100 tok/s");
    await update();
    now = 11_000;
    await emit("message_end", { message: assistant(50) });
    expect(footer()).toContain("50.0 tok/s");
  });

  it.each([
    ["failed", assistant(100, "error"), 1_000],
    ["aborted", assistant(100, "aborted"), 1_000],
    ["missing generation start", assistant(100), 1_000],
    ["short", assistant(100), 249],
    ["zero output", assistant(0), 1_000],
    ["negative output", assistant(-1), 1_000],
    ["non-finite output", assistant(Number.NaN), 1_000],
    ["non-finite duration", assistant(100), Number.POSITIVE_INFINITY],
    ["negative duration", assistant(100), -1],
    ["overflow rate", assistant(Number.MAX_VALUE), 250],
  ])("retains the last valid rate, if any, after a %s completion and recovers", async (name, message, elapsed) => {
    for (const measured of [false, true]) {
      const { emit, update, footer } = createHarness();
      await emit("session_start");
      now = 0;
      if (measured) {
        await update();
        now = 1_000;
        await emit("message_end", { message: assistant(100) });
        expect(footer()).toContain("100 tok/s");
      }

      now = 2_000;
      await emit("turn_start");
      await emit("before_provider_request");
      if (name !== "missing generation start") await update();
      now += elapsed;
      await emit("message_end", { message });
      if (measured) expect(footer()).toContain("100 tok/s");
      else expect(footer()).not.toContain("tok/s");

      now = 4_000;
      await emit("message_end", { message: assistant(50) });
      if (measured) expect(footer()).toContain("100 tok/s");
      else expect(footer()).not.toContain("tok/s");

      await update();
      now = 5_000;
      await emit("message_end", { message: assistant(50) });
      expect(footer()).toContain("50.0 tok/s");
    }
  });

  it("ignores non-assistant boundaries and updates and consumes timing only once", async () => {
    const { emit, update, footer } = createHarness();
    await emit("session_start");
    now = 0;
    await emit("message_update", { message: { role: "user" }, assistantMessageEvent: { type: "text_delta", delta: "user" } });
    now = 1_000;
    await update();
    await emit("message_start", { message: { role: "user" } });
    await emit("message_end", { message: { role: "toolResult" } });
    now = 2_000;
    await emit("message_end", { message: assistant(100) });
    expect(footer()).toContain("100 tok/s");
    now = 3_000;
    await emit("message_end", { message: assistant(100) });
    expect(footer()).toContain("100 tok/s");
  });

  it("ignores non-finite start times", async () => {
    const { emit, update, footer } = createHarness();
    await emit("session_start");
    now = Number.NaN;
    await update();
    now = 1_000;
    await emit("message_end", { message: assistant(100) });
    expect(footer()).not.toContain("tok/s");
  });

  it.each([[100, "100"], [50, "50.0"], [5, "5.00"], [25, "100", 250]])(
    "keeps precision, dim color, position, width priority and model-selection retention for %s tokens",
    async (output, formatted, elapsed = 1_000) => {
      const { emit, update, footer, styles } = createHarness();
      await emit("session_start");
      now = 0;
      await update();
      now = elapsed;
      await emit("message_end", { message: assistant(output) });
      expect(footer()).toContain(`model · ${formatted} tok/s`);
      expect(styles).toContainEqual(["dim", `${formatted} tok/s`]);
      for (const width of [20, 40, 80, 120]) {
        const rendered = footer(width);
        for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
      }
      expect(footer(20)).not.toContain("tok/s");
      expect(footer(40)).toContain("model");
      expect(footer(40)).not.toContain("tok/s");
      expect(footer(80)).toContain(`${formatted} tok/s`);

      await emit("model_select");
      expect(footer()).toContain(`${formatted} tok/s`);
    },
  );

  it.each(["session_start", "session_tree", "session_shutdown"])("clears completed and in-flight rates on %s", async (event) => {
    const { emit, update, footer } = createHarness();
    await emit("session_start");
    now = 0;
    await update();
    now = 1_000;
    await emit("message_end", { message: assistant(100) });
    expect(footer()).toContain("100 tok/s");

    now = 2_000;
    await emit("turn_start");
    await update();
    await emit(event);
    expect(footer()).not.toContain("tok/s");

    now = 3_000;
    await emit("message_end", { message: assistant(100) });
    expect(footer()).not.toContain("tok/s");
  });

  it("remains safe without a UI", async () => {
    const { emit, update, ctx } = createHarness();
    ctx.hasUI = false;
    await expect(emit("session_start")).resolves.toBeUndefined();
    await expect(emit("turn_start")).resolves.toBeUndefined();
    await expect(emit("before_provider_request")).resolves.toBeUndefined();
    await expect(emit("message_start", { message: assistant(0) })).resolves.toBeUndefined();
    await expect(update()).resolves.toBeUndefined();
    now = 1_000;
    await expect(emit("message_end", { message: assistant(100) })).resolves.toBeUndefined();
  });
});
