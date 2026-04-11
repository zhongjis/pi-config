import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockAgentDir = "";

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getAgentDir: () => mockAgentDir,
}));

import {
  HANDOFF_CLEAR_CHANNEL,
  HANDOFF_EXECUTION_KICKOFF_EVENT,
  HANDOFF_GET_CHANNEL,
  HANDOFF_MARK_CONSUMED_CHANNEL,
  HANDOFF_PING_CHANNEL,
  HANDOFF_PREPARE_CHANNEL,
  HANDOFF_READY_EVENT,
  createRequestEnvelope,
} from "../src/protocol.js";
import { getHandoffAuthorityPath, getHandoffBriefingPath, getPlanPath, hashPlanContent } from "../src/storage.js";

type EventHandler = (data: unknown) => void | Promise<void>;
type CommandDefinition = {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
};

type MockPiHarness = ReturnType<typeof createMockPi>;
type CommandHarness = ReturnType<typeof createCommandContext>;

function createMockPi() {
  const commands = new Map<string, CommandDefinition>();
  const eventHandlers = new Map<string, EventHandler[]>();
  const lifecycleHandlers = new Map<string, ((event: unknown, ctx: unknown) => void | Promise<void>)[]>();
  const emissions: Array<{ channel: string; data: unknown }> = [];

  const pi = {
    registerCommand(name: string, command: CommandDefinition) {
      commands.set(name, command);
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) {
      const handlers = lifecycleHandlers.get(event) ?? [];
      handlers.push(handler);
      lifecycleHandlers.set(event, handlers);
    },
    events: {
      emit(channel: string, data: unknown) {
        emissions.push({ channel, data });
        for (const handler of [...(eventHandlers.get(channel) ?? [])]) {
          void handler(data);
        }
      },
      on(channel: string, handler: EventHandler) {
        const handlers = eventHandlers.get(channel) ?? [];
        handlers.push(handler);
        eventHandlers.set(channel, handlers);
        return () => {
          const nextHandlers = (eventHandlers.get(channel) ?? []).filter((entry) => entry !== handler);
          eventHandlers.set(channel, nextHandlers);
        };
      },
    },
  };

  return {
    commands,
    pi,
    async executeCommand(name: string, args: string, ctx: unknown) {
      const command = commands.get(name);
      if (!command) {
        throw new Error(`Command ${name} not registered`);
      }

      return await command.handler(args, ctx);
    },
    async fireLifecycle(event: string, payloadOrCtx?: unknown, maybeCtx?: unknown) {
      const hasPayload = arguments.length >= 3;
      const payload = hasPayload ? payloadOrCtx : { type: event };
      const ctx = hasPayload ? maybeCtx : payloadOrCtx;
      const results: unknown[] = [];
      for (const handler of lifecycleHandlers.get(event) ?? []) {
        results.push(await handler(payload, ctx));
      }
      return results;
    },
    getEmissions(channel: string) {
      return emissions.filter((entry) => entry.channel === channel).map((entry) => entry.data);
    },
    getHandlerCount(channel: string) {
      return (eventHandlers.get(channel) ?? []).length;
    },
  };
}

async function initExtension(mock: MockPiHarness) {
  vi.resetModules();
  const { default: init } = await import("../src/index.js");
  init(mock.pi as never);
}

async function callRpc<T>(mock: MockPiHarness, channel: string, payload: unknown): Promise<T> {
  const requestId = `req-${Math.random().toString(36).slice(2)}`;

  return await new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      unsubscribe();
      reject(new Error(`${channel} timed out`));
    }, 250);

    const unsubscribe = mock.pi.events.on(`${channel}:reply:${requestId}`, (reply: unknown) => {
      clearTimeout(timeoutId);
      unsubscribe();
      resolve(reply as T);
    });

    mock.pi.events.emit(channel, createRequestEnvelope(requestId, payload));
  });
}

function createSessionContext(sessionId = "session-1") {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

function createCommandContext(
  options: {
    sessionId?: string;
    childSessionId?: string;
    cwd?: string;
    sessionFile?: string | undefined;
    branchEntries?: unknown[];
    hasUI?: boolean;
    model?: unknown;
    editorResult?: string | undefined;
    newSessionCancelled?: boolean;
    newSessionError?: Error;
  } = {},
) {
  const sessionId = options.sessionId ?? "session-1";
  const childSessionId = options.childSessionId ?? "session-child";
  const cwd = options.cwd ?? "/repo";
  const branchEntries = options.branchEntries ?? [];
  const hasUI = options.hasUI ?? true;
  const model = Object.prototype.hasOwnProperty.call(options, "model")
    ? options.model
    : { id: "test-model", name: "Test Model" };
  const sessionFile = Object.prototype.hasOwnProperty.call(options, "sessionFile")
    ? options.sessionFile
    : join(cwd, ".pi", "sessions", `${sessionId}.jsonl`);
  const editorResult = Object.prototype.hasOwnProperty.call(options, "editorResult")
    ? options.editorResult
    : "Reviewed handoff prompt";
  const newSessionCancelled = options.newSessionCancelled ?? false;

  const ui = {
    notify: vi.fn(),
    editor: vi.fn(async (_title: string, _initialValue: string) => editorResult),
    setEditorText: vi.fn(),
  };

  const ctx = {
    hasUI,
    model,
    modelRegistry: {},
    cwd,
    ui,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branchEntries,
      getCwd: () => cwd,
      getSessionFile: () => sessionFile,
    },
    waitForIdle: vi.fn(async () => {}),
    newSession: vi.fn(async (newSessionOptions?: { parentSession?: string; setup?: (sessionManager: unknown) => Promise<void> }) => {
      if (options.newSessionError) {
        throw options.newSessionError;
      }

      if (!newSessionCancelled) {
        await newSessionOptions?.setup?.({
          getSessionId: () => childSessionId,
        });
      }

      return { cancelled: newSessionCancelled };
    }),
  };

  return {
    ctx,
    ui,
    childStorageCtx: createSessionContext(childSessionId),
  };
}

async function writePlan(ctx: ReturnType<typeof createSessionContext>, content: string) {
  const planPath = getPlanPath(ctx);
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, content, "utf8");
}

describe("handoff RPC extension", () => {
  beforeEach(async () => {
    mockAgentDir = await mkdtemp(join(tmpdir(), "pi-handoff-rpc-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (mockAgentDir) {
      await rm(mockAgentDir, { recursive: true, force: true });
    }
  });

  it("broadcasts startup readiness, switches to missing on session start, and cleans up listeners on shutdown", async () => {
    const mock = createMockPi();
    await initExtension(mock);

    const initialReady = mock.getEmissions(HANDOFF_READY_EVENT).at(-1) as { readiness: { state: string; startupStatus?: string } };
    expect(initialReady.readiness).toMatchObject({
      state: "not-ready",
      startupStatus: "bootstrapping",
    });

    const pingReply = await callRpc<{
      success: true;
      data: { readiness: { state: string; startupStatus?: string } };
    }>(mock, HANDOFF_PING_CHANNEL, {});
    expect(pingReply).toMatchObject({
      success: true,
      data: {
        readiness: {
          state: "not-ready",
          startupStatus: "bootstrapping",
        },
      },
    });

    await mock.fireLifecycle("session_start", createSessionContext());

    const startedReady = mock.getEmissions(HANDOFF_READY_EVENT).at(-1) as {
      readiness: { state: string; missingResource?: string };
    };
    expect(startedReady.readiness).toMatchObject({
      state: "missing",
      missingResource: "handoff-authority",
    });

    const getReply = await callRpc<{
      success: true;
      data: { readiness: { state: string; missingResource?: string } };
    }>(mock, HANDOFF_GET_CHANNEL, {});
    expect(getReply).toMatchObject({
      success: true,
      data: {
        readiness: {
          state: "missing",
          missingResource: "handoff-authority",
        },
      },
    });

    expect(mock.getHandlerCount(HANDOFF_PING_CHANNEL)).toBe(1);
    expect(mock.getHandlerCount(HANDOFF_PREPARE_CHANNEL)).toBe(1);
    expect(mock.getHandlerCount(HANDOFF_GET_CHANNEL)).toBe(1);
    expect(mock.getHandlerCount(HANDOFF_MARK_CONSUMED_CHANNEL)).toBe(1);
    expect(mock.getHandlerCount(HANDOFF_CLEAR_CHANNEL)).toBe(1);

    await mock.fireLifecycle("session_shutdown", createSessionContext());

    expect(mock.getHandlerCount(HANDOFF_PING_CHANNEL)).toBe(0);
    expect(mock.getHandlerCount(HANDOFF_PREPARE_CHANNEL)).toBe(0);
    expect(mock.getHandlerCount(HANDOFF_GET_CHANNEL)).toBe(0);
    expect(mock.getHandlerCount(HANDOFF_MARK_CONSUMED_CHANNEL)).toBe(0);
    expect(mock.getHandlerCount(HANDOFF_CLEAR_CHANNEL)).toBe(0);
  });

  it("prepares and retrieves handoff artifacts from session-local storage", async () => {
    const ctx = createSessionContext();
    const mock = createMockPi();
    const planContent = "# Example Plan\n\n- Ship the feature\n";
    await writePlan(ctx, planContent);
    await initExtension(mock);
    await mock.fireLifecycle("session_start", ctx);

    const prepareReply = await callRpc<{
      success: true;
      data: {
        authority: {
          handoffId: string;
          planHash: string;
          planTitle?: string;
          producerMode: string;
          targetMode: string;
          kickoffPrompt: string;
        };
        briefingPath: string;
        authorityPath: string;
        readiness: { state: string; ready: boolean };
      };
    }>(mock, HANDOFF_PREPARE_CHANNEL, {
      handoffId: "handoff-1",
      briefing: "Implement the approved plan.",
      producerMode: "fuxi",
      targetMode: "houtu",
      kickoffPrompt: "Start implementation.",
      createdAt: "2026-04-11T12:00:00.000Z",
    });

    expect(prepareReply).toMatchObject({
      success: true,
      data: {
        authority: {
          handoffId: "handoff-1",
          planHash: hashPlanContent(planContent),
          planTitle: "Example Plan",
          producerMode: "fuxi",
          targetMode: "houtu",
          kickoffPrompt: "Start implementation.",
        },
        readiness: {
          state: "ready",
          ready: true,
        },
      },
    });
    expect(prepareReply.data.briefingPath).toContain("/local/session-1/HANDOFF.md");
    expect(prepareReply.data.authorityPath).toContain("/local/session-1/HANDOFF.json");

    expect(await readFile(getHandoffBriefingPath(ctx), "utf8")).toBe("Implement the approved plan.");
    expect(await readFile(getHandoffAuthorityPath(ctx), "utf8")).toContain('"handoffId": "handoff-1"');

    const getReply = await callRpc<{
      success: true;
      data: {
        authority: { handoffId: string; status: string; planHash: string };
        briefing: string;
        readiness: { state: string; ready: boolean };
      };
    }>(mock, HANDOFF_GET_CHANNEL, {});

    expect(getReply).toMatchObject({
      success: true,
      data: {
        authority: {
          handoffId: "handoff-1",
          status: "pending",
          planHash: hashPlanContent(planContent),
        },
        briefing: "Implement the approved plan.",
        readiness: {
          state: "ready",
          ready: true,
        },
      },
    });

    const readyEvent = mock.getEmissions(HANDOFF_READY_EVENT).at(-1) as { readiness: { state: string; ready: boolean } };
    expect(readyEvent.readiness).toMatchObject({
      state: "ready",
      ready: true,
    });
  });

  it("returns stale readiness when PLAN.md changes after prepare", async () => {
    const ctx = createSessionContext();
    const mock = createMockPi();
    const originalPlan = "# Example Plan\n\n- Original\n";
    const updatedPlan = "# Example Plan\n\n- Updated\n";
    await writePlan(ctx, originalPlan);
    await initExtension(mock);
    await mock.fireLifecycle("session_start", ctx);

    await callRpc(mock, HANDOFF_PREPARE_CHANNEL, {
      handoffId: "handoff-2",
      briefing: "Use the original plan.",
      producerMode: "fuxi",
      targetMode: "houtu",
      kickoffPrompt: "Start implementation.",
    });

    await writePlan(ctx, updatedPlan);

    const getReply = await callRpc<{
      success: true;
      data: {
        readiness: { state: string; ready: boolean; storedPlanHash?: string; latestPlanHash?: string };
      };
    }>(mock, HANDOFF_GET_CHANNEL, {});

    expect(getReply).toMatchObject({
      success: true,
      data: {
        readiness: {
          state: "stale",
          ready: false,
          storedPlanHash: hashPlanContent(originalPlan),
          latestPlanHash: hashPlanContent(updatedPlan),
        },
      },
    });
  });

  it("marks handoff consumed by updating authority only, then clears persisted artifacts", async () => {
    const ctx = createSessionContext();
    const mock = createMockPi();
    const planContent = "# Example Plan\n\n- Ship the feature\n";
    await writePlan(ctx, planContent);
    await initExtension(mock);
    await mock.fireLifecycle("session_start", ctx);

    await callRpc(mock, HANDOFF_PREPARE_CHANNEL, {
      handoffId: "handoff-3",
      briefing: "Keep this briefing content.",
      producerMode: "fuxi",
      targetMode: "houtu",
      kickoffPrompt: "Start implementation.",
    });

    const briefingBefore = await readFile(getHandoffBriefingPath(ctx), "utf8");
    const consumedAt = "2026-04-11T15:30:00.000Z";
    const markReply = await callRpc<{
      success: true;
      data: {
        authority?: { handoffId: string; status: string; consumedAt?: string };
        readiness: { state: string; ready: boolean; handoffStatus?: string };
      };
    }>(mock, HANDOFF_MARK_CONSUMED_CHANNEL, { consumedAt });

    expect(markReply).toMatchObject({
      success: true,
      data: {
        authority: {
          handoffId: "handoff-3",
          status: "consumed",
          consumedAt,
        },
        readiness: {
          state: "not-ready",
          ready: false,
          handoffStatus: "consumed",
        },
      },
    });
    expect(await readFile(getHandoffBriefingPath(ctx), "utf8")).toBe(briefingBefore);
    expect(await readFile(getHandoffAuthorityPath(ctx), "utf8")).toContain('"status": "consumed"');

    const clearReply = await callRpc<{
      success: true;
      data: { readiness: { state: string; ready: boolean; missingResource?: string } };
    }>(mock, HANDOFF_CLEAR_CHANNEL, {});

    expect(clearReply).toMatchObject({
      success: true,
      data: {
        readiness: {
          state: "missing",
          ready: false,
          missingResource: "handoff-authority",
        },
      },
    });

    const getReply = await callRpc<{
      success: true;
      data: { authority?: unknown; briefing?: unknown; readiness: { state: string; missingResource?: string } };
    }>(mock, HANDOFF_GET_CHANNEL, {});

    expect(getReply).toMatchObject({
      success: true,
      data: {
        authority: undefined,
        briefing: undefined,
        readiness: {
          state: "missing",
          missingResource: "handoff-authority",
        },
      },
    });
  });
});

describe("execution kickoff sentinel", () => {
  beforeEach(async () => {
    mockAgentDir = await mkdtemp(join(tmpdir(), "pi-handoff-kickoff-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (mockAgentDir) {
      await rm(mockAgentDir, { recursive: true, force: true });
    }
  });

  it("blocks kickoff sentinels when HANDOFF.json is missing", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const command = createCommandContext();
    await mock.fireLifecycle("session_start", command.ctx);

    const results = await mock.fireLifecycle(
      "input",
      { text: "__PI_HANDOFF_EXECUTE__:handoff-missing" },
      command.ctx,
    );

    expect(results[0]).toEqual({ action: "handled" });
    expect(command.ui.notify).toHaveBeenCalledWith(
      "local://HANDOFF.json is missing for execution handoff handoff-missing. Switched back to Fu Xi. Rerun Execute from the latest saved plan.",
      "warning",
    );
    expect(mock.getEmissions(HANDOFF_EXECUTION_KICKOFF_EVENT).at(-1)).toMatchObject({
      handoffId: "handoff-missing",
      status: "invalid",
      reason: "local://HANDOFF.json is missing for execution handoff handoff-missing.",
    });
  });

  it("blocks kickoff sentinels when the prepared handoff is stale", async () => {
    const mock = createMockPi();
    const command = createCommandContext();
    const originalPlan = "# Example Plan\n\n- Original\n";
    const updatedPlan = "# Example Plan\n\n- Updated\n";

    await writePlan(command.ctx as ReturnType<typeof createSessionContext>, originalPlan);
    await initExtension(mock);
    await mock.fireLifecycle("session_start", command.ctx);

    const prepareReply = await callRpc<{
      success: true;
      data: {
        authority: { handoffId: string; kickoffPrompt: string };
      };
    }>(mock, HANDOFF_PREPARE_CHANNEL, {
      handoffId: "handoff-stale",
      briefing: "Execute the original plan.",
      producerMode: "fuxi",
      targetMode: "houtu",
      kickoffPrompt: "__PI_HANDOFF_EXECUTE__:handoff-stale",
    });

    await writePlan(command.ctx as ReturnType<typeof createSessionContext>, updatedPlan);

    const results = await mock.fireLifecycle(
      "input",
      { text: prepareReply.data.authority.kickoffPrompt },
      command.ctx,
    );

    expect(results[0]).toEqual({ action: "handled" });
    expect(command.ui.notify).toHaveBeenCalledWith(
      "HANDOFF.json planHash does not match the latest local://PLAN.md. Switched back to Fu Xi. Rerun Execute from the latest saved plan.",
      "warning",
    );
    expect(mock.getEmissions(HANDOFF_EXECUTION_KICKOFF_EVENT).at(-1)).toMatchObject({
      handoffId: "handoff-stale",
      status: "invalid",
      reason: "HANDOFF.json planHash does not match the latest local://PLAN.md.",
    });
  });
});

describe("/handoff command", () => {
  beforeEach(async () => {
    mockAgentDir = await mkdtemp(join(tmpdir(), "pi-handoff-command-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (mockAgentDir) {
      await rm(mockAgentDir, { recursive: true, force: true });
    }
  });

  it("shows usage when no goal is provided", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const command = createCommandContext();

    await mock.executeCommand("handoff", "   ", command.ctx);

    expect(command.ui.notify).toHaveBeenCalledWith("Usage: /handoff <goal>", "error");
    expect(command.ctx.waitForIdle).not.toHaveBeenCalled();
    expect(command.ctx.newSession).not.toHaveBeenCalled();
  });

  it("requires local://PLAN.md in the current session", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const command = createCommandContext();

    await mock.executeCommand("handoff", "continue task #11", command.ctx);

    expect(command.ui.notify).toHaveBeenCalledWith(
      "handoff requires local://PLAN.md in the current session",
      "error",
    );
    expect(command.ui.editor).not.toHaveBeenCalled();
    expect(command.ctx.newSession).not.toHaveBeenCalled();
  });

  it("falls back to manual handoff when the current session has no parent-session file", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const command = createCommandContext({
      sessionFile: undefined,
      editorResult: "  Reviewed handoff prompt  ",
    });
    await writePlan(command.ctx as ReturnType<typeof createSessionContext>, "# Example Plan\n\n- Ship the feature\n");

    await mock.executeCommand("handoff", "finish the feature", command.ctx);

    expect(command.ctx.waitForIdle).not.toHaveBeenCalled();
    expect(command.ctx.newSession).not.toHaveBeenCalled();
    expect(command.ui.setEditorText).toHaveBeenCalledWith("Reviewed handoff prompt");
    expect(command.ui.notify).toHaveBeenCalledWith(
      "Handoff draft prepared, but this session cannot create a linked child session yet. Start a new session manually and submit the draft there.",
      "warning",
    );
  });

  it("creates a reviewed child-session handoff with parentSession linkage", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const command = createCommandContext({
      sessionId: "parent-session",
      childSessionId: "child-session",
      cwd: "/home/zshen/personal/pi-config",
      editorResult: "Reviewed child prompt\n\nPlease continue carefully.\n",
      branchEntries: [
        { type: "branch_summary", summary: "Current work touches extensions/handoff/src/index.ts and local://PLAN.md" },
        { type: "message", message: { role: "user", content: "Continue task #11 in extensions/handoff/test/index.test.ts" } },
        { type: "message", message: { role: "assistant", content: "I inspected local://PLAN.md and extensions/handoff/src/index.ts" } },
      ],
    });
    const planContent = "# Example Plan\n\n- Verify /handoff command behavior\n- Update extensions/handoff/test/index.test.ts\n";
    await writePlan(command.ctx as ReturnType<typeof createSessionContext>, planContent);

    await mock.executeCommand("handoff", "continue task #11 cleanly", command.ctx);

    expect(command.ui.editor).toHaveBeenCalledTimes(1);
    expect(command.ui.editor).toHaveBeenCalledWith(
      "Review handoff prompt",
      expect.stringContaining("Continue this work in a new child session."),
    );

    expect(command.ui.editor.mock.calls[0]).toBeDefined();
    const firstEditorCall = command.ui.editor.mock.calls[0]!;
    const generatedPrompt = firstEditorCall[1];
    expect(typeof generatedPrompt).toBe("string");
    expect(generatedPrompt).toContain("## Goal\ncontinue task #11 cleanly");
    expect(generatedPrompt).toContain("- Working directory: /home/zshen/personal/pi-config");
    expect(generatedPrompt).toContain("- Plan reference: local://PLAN.md");
    expect(generatedPrompt).toContain("Summary: Current work touches extensions/handoff/src/index.ts and local://PLAN.md");
    expect(generatedPrompt).toContain("User: Continue task #11 in extensions/handoff/test/index.test.ts");
    expect(generatedPrompt).toContain("Assistant: I inspected local://PLAN.md and extensions/handoff/src/index.ts");
    expect(generatedPrompt).toContain("- extensions/handoff/src/index.ts");
    expect(generatedPrompt).toContain("- extensions/handoff/test/index.test.ts");
    expect(generatedPrompt).toContain("- local://PLAN.md");

    expect(command.ctx.waitForIdle).toHaveBeenCalledTimes(1);
    expect(command.ctx.newSession).toHaveBeenCalledTimes(1);
    expect(command.ctx.newSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSession: "/home/zshen/personal/pi-config/.pi/sessions/parent-session.jsonl",
        setup: expect.any(Function),
      }),
    );

    expect(await readFile(getPlanPath(command.childStorageCtx), "utf8")).toBe(planContent);
    expect(await readFile(getHandoffBriefingPath(command.childStorageCtx), "utf8")).toBe(
      "Reviewed child prompt\n\nPlease continue carefully.",
    );

    const authority = JSON.parse(await readFile(getHandoffAuthorityPath(command.childStorageCtx), "utf8")) as {
      producerMode: string;
      targetMode: string;
      kickoffPrompt: string;
      planHash: string;
      status: string;
    };
    expect(authority).toMatchObject({
      producerMode: "handoff-command",
      targetMode: "child-session",
      kickoffPrompt: "Reviewed child prompt\n\nPlease continue carefully.",
      planHash: hashPlanContent(planContent),
      status: "pending",
    });

    expect(command.ui.setEditorText).toHaveBeenCalledWith("Reviewed child prompt\n\nPlease continue carefully.");
    expect(command.ui.notify).toHaveBeenCalledWith(
      "Handoff ready in a new child session. Submit when ready.",
      "info",
    );
  });
});
