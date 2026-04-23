import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "./fixtures/mock-context.js";
import { createMockPi } from "./fixtures/mock-pi.js";

const bashMockState = vi.hoisted(() => ({
  createCalls: [] as string[],
  executeCalls: [] as Array<{
    boundCwd: string;
    toolCallId: string;
    params: { command: string; timeout?: number };
    ctx: { cwd: string };
  }>,
}));

const createBashToolDefinitionMock = vi.hoisted(() =>
  vi.fn((cwd: string) => {
    bashMockState.createCalls.push(cwd);
    return {
      name: "bash",
      label: "bash",
      execute: vi.fn(async (toolCallId: string, params: { command: string; timeout?: number }, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) => {
        bashMockState.executeCalls.push({ boundCwd: cwd, toolCallId, params, ctx });
        return {
          content: [{ type: "text", text: `ran ${params.command}` }],
          details: { cwd },
        };
      }),
    };
  }),
);

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await import("./stubs/pi-coding-agent.js");

  return {
    ...actual,
    DEFAULT_MAX_BYTES: 50 * 1024,
    createBashToolDefinition: createBashToolDefinitionMock,
    formatSize(bytes: number) {
      return `${bytes} bytes`;
    },
    truncateToVisualLines(text: string, maxLines: number) {
      const lines = text.split("\n");
      return {
        visualLines: lines.slice(0, maxLines),
        skippedCount: Math.max(lines.length - maxLines, 0),
      };
    },
  };
});

describe("better-bash-tool", () => {
  beforeEach(() => {
    createBashToolDefinitionMock.mockClear();
    bashMockState.createCalls.length = 0;
    bashMockState.executeCalls.length = 0;
  });

  it("rebinds execution to the resolved cwd without rewriting the command", async () => {
    const { default: initBetterBashTool } = await import("../extensions/better-bash-tool.js");
    const mock = createMockPi();
    initBetterBashTool(mock.pi as never);

    const tool = mock.tools.get("bash") as { execute: (...args: unknown[]) => Promise<unknown> };
    expect(tool).toBeDefined();
    expect(createBashToolDefinitionMock).toHaveBeenCalledTimes(1);
    expect(createBashToolDefinitionMock).toHaveBeenCalledWith(process.cwd());

    const ctx = { ...createMockContext(), cwd: "/repo/worktree" };
    const result = await tool.execute(
      "call-1",
      { command: "pwd", timeout: 15, cwd: "packages/app" },
      undefined,
      undefined,
      ctx,
    );

    const resolvedCwd = resolve("/repo/worktree", "packages/app");
    expect(createBashToolDefinitionMock).toHaveBeenNthCalledWith(2, resolvedCwd);
    expect(bashMockState.executeCalls).toHaveLength(1);
    expect(bashMockState.executeCalls[0]).toMatchObject({
      boundCwd: resolvedCwd,
      toolCallId: "call-1",
      params: { command: "pwd", timeout: 15 },
      ctx: { cwd: "/repo/worktree" },
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "ran pwd" }],
      details: { cwd: resolvedCwd },
    });
  });
});
