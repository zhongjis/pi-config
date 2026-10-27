import { mkdtempSync as tempDir, rmSync as removeDir } from "node:fs";
import { tmpdir as tempRoot } from "node:os";
import { join as pathJoin } from "node:path";
import { beforeEach as fixtureBefore, afterEach as fixtureAfter } from "vitest";
import { writeFixtureAgent } from "./helpers/fixture-agent.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async (importOriginal) =>
  (await import("./helpers/session-seam.js")).mockOpenSession(await importOriginal()));

import { openSession } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { fakeSession, opened } from "./helpers/session-seam.js";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          eventHandlers.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(() => {
        throw new Error("stale extension context");
      }),
    } as any,
    tools,
    handlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

describe("print mode background notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ignores stale-context errors from delayed completion nudges", async () => {
    vi.mocked(openSession).mockResolvedValue(opened(fakeSession(() => "done")));

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    const agentTool = tools.get("agent");
    await agentTool.execute(
      "tool-call-1",
      {
        prompt: "reply done",
        description: "tiny child",
        subagent_type: "fixture",
        run_in_background: true,
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    await vi.advanceTimersByTimeAsync(100); // smart-join batch debounce
    await vi.advanceTimersByTimeAsync(200); // notification hold window

    expect(pi.sendMessage).toHaveBeenCalled();

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });
});

let fixtureCwd: string;
let originalCwd: string;
fixtureBefore(() => {
  originalCwd = process.cwd();
  fixtureCwd = tempDir(pathJoin(tempRoot(), "subagent-fixture-"));
  writeFixtureAgent(fixtureCwd);
  process.chdir(fixtureCwd);
});
fixtureAfter(() => {
  process.chdir(originalCwd);
  removeDir(fixtureCwd, { recursive: true, force: true });
});
