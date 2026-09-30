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
type EventHandler = (event: { message?: ReturnType<typeof assistant> }, ctx: unknown) => Promise<void> | void;

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

  const emit = async (event: string, payload: { message?: ReturnType<typeof assistant> } = {}) => {
    await handlers.get(event)?.(payload, ctx);
  };
  const footer = (width = 200) => {
    if (!footerFactory) throw new Error("footer was not installed");
    return footerFactory(
      { requestRender(): void {} },
      { fg: (_color, text) => text, getThinkingBorderColor: () => () => "" },
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

  return { emit, footer, ctx };
}

describe("qol footer effective output rate", () => {
  let now = 0;

  beforeEach(() => {
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-visuals:footer")];
  });

  it("measures provider request latency through completion, not session history or time between turns", async () => {
    const { emit, footer } = createHarness();
    await emit("session_start");
    expect(footer()).not.toContain("effective tok/s");

    now = 100;
    await emit("turn_start");
    await emit("before_provider_request");
    now = 2_100;
    await emit("message_end", { message: assistant(200) });
    expect(footer()).toContain("100 effective tok/s");

    now = 3_000;
    await emit("tool_execution_start");
    now = 9_000;
    await emit("tool_execution_end");
    now = 10_000;
    await emit("turn_start");
    now = 11_000;
    await emit("before_provider_request");
    now = 13_000;
    await emit("message_end", { message: assistant(100) });
    expect(footer()).toContain("50.0 effective tok/s");
  });

  it("keeps the first request time across retries and retains the completed rate while streaming", async () => {
    const { emit, footer } = createHarness();
    await emit("session_start");
    now = 1_000;
    await emit("turn_start");
    await emit("before_provider_request");
    now = 2_500;
    await emit("before_provider_request");
    await emit("message_update", { message: assistant(1) });
    expect(footer()).not.toContain("effective tok/s");
    now = 5_500;
    await emit("message_end", { message: assistant(180) });
    expect(footer()).toContain("40.0 effective tok/s");

    now = 8_000;
    await emit("turn_start");
    await emit("before_provider_request");
    expect(footer()).toContain("40.0 effective tok/s");
  });

  it.each([
    ["failed", assistant(100, "error"), 1_000],
    ["aborted", assistant(100, "aborted"), 1_000],
    ["missing request start", assistant(100), 1_000],
    ["short", assistant(100), 249],
    ["zero output", assistant(0), 1_000],
    ["non-finite output", assistant(Number.NaN), 1_000],
  ])("hides the rate after a %s completion", async (_name, message, elapsed) => {
    const { emit, footer } = createHarness();
    await emit("session_start");
    now = 0;
    await emit("turn_start");
    await emit("before_provider_request");
    now = 1_000;
    await emit("message_end", { message: assistant(100) });
    expect(footer()).toContain("100 effective tok/s");

    now = 2_000;
    await emit("turn_start");
    if (_name !== "missing request start") await emit("before_provider_request");
    now += elapsed;
    await emit("message_end", { message });
    expect(footer()).not.toContain("effective tok/s");
  });

  it("keeps the rate on model selection and preserves footer priority", async () => {
    const { emit, footer } = createHarness();
    await emit("session_start");
    now = 0;
    await emit("turn_start");
    await emit("before_provider_request");
    now = 1_000;
    await emit("message_end", { message: assistant(100) });
    expect(footer()).toContain("100 effective tok/s");
    expect(footer(20)).not.toContain("effective tok/s");

    await emit("model_select");
    expect(footer()).toContain("100 effective tok/s");
  });

  it.each(["session_start", "session_tree", "session_shutdown"])("clears completed and in-flight rates on %s", async (event) => {
    const { emit, footer } = createHarness();
    await emit("session_start");
    now = 0;
    await emit("turn_start");
    await emit("before_provider_request");
    now = 1_000;
    await emit("message_end", { message: assistant(100) });
    expect(footer()).toContain("100 effective tok/s");

    now = 2_000;
    await emit("turn_start");
    await emit("before_provider_request");
    await emit(event);
    expect(footer()).not.toContain("effective tok/s");

    now = 3_000;
    await emit("message_end", { message: assistant(100) });
    expect(footer()).not.toContain("effective tok/s");
  });

  it("remains safe without a UI", async () => {
    const handlers = new Map<string, EventHandler>();
    const pi = {
      getThinkingLevel: () => "off",
      on(event: string, handler: EventHandler): void {
        handlers.set(event, handler);
      },
    };
    installFooterVisuals(pi as never);
    const ctx = { hasUI: false };

    await expect(handlers.get("session_start")?.({}, ctx)).resolves.toBeUndefined();
    await expect(handlers.get("turn_start")?.({}, ctx)).resolves.toBeUndefined();
    await expect(handlers.get("before_provider_request")?.({}, ctx)).resolves.toBeUndefined();
    now = 1_000;
    await expect(handlers.get("message_end")?.({ message: assistant(100) }, ctx)).resolves.toBeUndefined();
  });
});
