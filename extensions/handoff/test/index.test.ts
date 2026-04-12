import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeMock = vi.fn();

vi.mock("@mariozechner/pi-ai", () => ({
  complete: completeMock,
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  BorderedLoader: class {
    signal = undefined;
    onAbort?: () => void;
    constructor(..._args: unknown[]) {}
  },
  convertToLlm: (messages: unknown) => messages,
  serializeConversation: (messages: unknown) => JSON.stringify(messages),
}));

type CommandDefinition = {
  description: string;
  handler: (args: string, ctx: any) => Promise<void> | void;
};

function createMockPi() {
  const commands = new Map<string, CommandDefinition>();
  const lifecycleHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void> | void>>();
  const sendUserMessage = vi.fn();

  const pi = {
    registerCommand(name: string, command: CommandDefinition) {
      commands.set(name, command);
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
      const handlers = lifecycleHandlers.get(event) ?? [];
      handlers.push(handler);
      lifecycleHandlers.set(event, handlers);
    },
    sendUserMessage,
  };

  return {
    pi,
    sendUserMessage,
    async executeCommand(name: string, args: string, ctx: unknown) {
      const command = commands.get(name);
      if (!command) {
        throw new Error(`Command ${name} not registered`);
      }
      await command.handler(args, ctx);
    },
    async fireLifecycle(event: string, payload: unknown, ctx?: unknown) {
      for (const handler of lifecycleHandlers.get(event) ?? []) {
        await handler(payload, ctx);
      }
    },
  };
}

function createCommandContext(options: {
  summaryChoice?: string | null;
  currentModel?: { provider: string; id: string } | undefined;
  customResult?: string | null;
} = {}) {
  const appendedCustomEntries: Array<{ customType: string; data: unknown }> = [];
  const ui = {
    notify: vi.fn(),
    select: vi.fn(async () => options.summaryChoice ?? null),
    custom: vi.fn(async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: string | null) => void) => unknown) => {
      return await new Promise<string | null>((resolve) => {
        factory({}, {}, {}, resolve);
      });
    }),
  };

  const ctx = {
    hasUI: true,
    ui,
    model: options.currentModel,
    modelRegistry: {
      getAvailable: () => [{ provider: "anthropic", id: "claude-haiku-4-5" }],
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key", headers: {} })),
    },
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Please continue this work" }],
          },
        },
      ],
      getSessionFile: () => "/repo/.pi/sessions/parent.jsonl",
    },
    waitForIdle: vi.fn(async () => {}),
    newSession: vi.fn(async ({ setup }: { setup?: (sessionManager: unknown) => Promise<void> }) => {
      await setup?.({
        appendCustomEntry: (customType: string, data: unknown) => appendedCustomEntries.push({ customType, data }),
      });
      return { cancelled: false };
    }),
  };

  return { ctx, ui, appendedCustomEntries };
}

async function initExtension(mock: ReturnType<typeof createMockPi>) {
  vi.resetModules();
  const { default: init } = await import("../src/index.js");
  init(mock.pi as never);
}

describe("handoff extension", () => {
  let tempHome = "";
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "handoff-home-"));
    process.env.HOME = tempHome;
    completeMock.mockReset();
    completeMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "## Context\nSummary\n\n## Task\nProceed" }],
    });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("creates a child session and auto-sends deterministic prompt when summarization is disabled", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const { ctx, appendedCustomEntries } = createCommandContext();

    await mock.executeCommand("handoff", '-mode houtu -no-summarize "ship feature"', ctx);

    expect(ctx.newSession).toHaveBeenCalledTimes(1);
    expect(appendedCustomEntries).toEqual([{ customType: "agent-mode", data: { mode: "houtu" } }]);

    expect(mock.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(mock.sendUserMessage.mock.calls[0][0]).toContain("ship feature");
    expect(mock.sendUserMessage.mock.calls[0][0]).toContain("Parent session");
    expect(mock.sendUserMessage.mock.invocationCallOrder[0]).toBeGreaterThan(ctx.newSession.mock.invocationCallOrder[0]);
  });

  it("does not auto-send prompt when new session creation is cancelled", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const { ctx, ui } = createCommandContext();

    ctx.newSession = vi.fn(async ({ setup }: { setup?: (sessionManager: unknown) => Promise<void> }) => {
      await setup?.({ appendCustomEntry: vi.fn() });
      return { cancelled: true };
    });

    await mock.executeCommand("handoff", '-no-summarize "ship feature"', ctx);

    expect(mock.sendUserMessage).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("New session cancelled.", "info");
  });

  it("summarizes with selected model and remembers the last summary model", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const { ctx, ui } = createCommandContext({ summaryChoice: "anthropic/claude-haiku-4-5" });

    await mock.executeCommand("handoff", "investigate auth flow", ctx);

    expect(ui.select).toHaveBeenCalledWith("Summary model", ["anthropic/claude-haiku-4-5"]);
    expect(completeMock).toHaveBeenCalledTimes(1);

    const saved = await readFile(join(tempHome, ".pi", "agent", "handoff.json"), "utf8");
    expect(saved).toContain("anthropic/claude-haiku-4-5");
  });
});
