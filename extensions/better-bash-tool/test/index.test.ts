import { homedir } from "node:os";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";

const nativeRenderResultMock = vi.hoisted(() => vi.fn(() => ({ native: "rendered" })));

const bashMockState = vi.hoisted(() => ({
  createCalls: [] as string[],
  executeCalls: [] as Array<{
    boundCwd: string;
    toolCallId: string;
    params: { command: string; timeout?: number };
    onUpdate: unknown;
    ctx: { cwd: string };
  }>,
}));

const createBashToolDefinitionMock = vi.hoisted(() =>
  vi.fn((cwd: string) => {
    bashMockState.createCalls.push(cwd);
    return {
      name: "bash",
      label: "bash",
      renderResult: nativeRenderResultMock,
      execute: vi.fn(async (toolCallId: string, params: { command: string; timeout?: number }, _signal: unknown, onUpdate: unknown, ctx: { cwd: string }) => {
        bashMockState.executeCalls.push({ boundCwd: cwd, toolCallId, params, onUpdate, ctx });
        return {
          content: [{ type: "text", text: `ran ${params.command}` }],
          details: { cwd },
        };
      }),
    };
  }),
);

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await import("../../../test/stubs/pi-coding-agent.js");

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

type Renderable = { text?: string; render?: (width: number) => string[] };

function renderLines(component: Renderable, width: number): string[] {
  if (component.render) return component.render(width);
  return (component.text ?? "").split("\n");
}

function expectWidthSafe(component: Renderable): void {
  for (const width of [20, 40, 80, 120]) {
    for (const line of renderLines(component, width)) {
      expect(visibleWidth(line), `${JSON.stringify(line)} at width ${width}`).toBeLessThanOrEqual(width);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}

describe("better-bash-tool", () => {
  beforeEach(() => {
    createBashToolDefinitionMock.mockClear();
    bashMockState.createCalls.length = 0;
    bashMockState.executeCalls.length = 0;
    nativeRenderResultMock.mockClear();
  });

  it("rebinds execution to the resolved cwd without rewriting the command", async () => {
    const { default: initBetterBashTool } = await import("../index.js");
    const mock = createMockPi();
    initBetterBashTool(mock.pi as never);

    const tool = mock.tools.get("bash") as {
      execute: (...args: unknown[]) => Promise<unknown>;
      renderCall: (...args: unknown[]) => Renderable;
      renderResult: unknown;
    };
    expect(tool).toBeDefined();
    expect(createBashToolDefinitionMock).toHaveBeenCalledTimes(1);
    expect(createBashToolDefinitionMock).toHaveBeenCalledWith(process.cwd());

    const ctx = { ...createMockContext(), cwd: "/repo/worktree" };
    const onUpdate = vi.fn();
    const result = await tool.execute(
      "call-1",
      { command: "pwd", timeout: 15, cwd: "packages/app" },
      undefined,
      onUpdate,
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
    expect(bashMockState.executeCalls[0]?.onUpdate).toBe(onUpdate);
    expect(tool.renderResult).toBe(nativeRenderResultMock);
    expect(result).toMatchObject({
      content: [{ type: "text", text: "ran pwd" }],
      details: { cwd: resolvedCwd },
    });
  });

  it("renders aligned call row with tool name, shortened cwd, command preview, and timeout", async () => {
    const { default: initBetterBashTool } = await import("../index.js");
    const mock = createMockPi();
    initBetterBashTool(mock.pi as never);

    const tool = mock.tools.get("bash") as {
      renderCall: (...args: unknown[]) => Renderable;
      renderResult: unknown;
    };
    const ctx = { ...createMockContext(), cwd: process.cwd() };
    const args = deepFreeze({ command: "pnpm test -- --runInBand", timeout: 9, cwd: `${homedir()}/personal/pi-config` });

    const rendered = tool.renderCall(
      args,
      ctx.ui.theme,
      { cwd: ctx.cwd, state: {}, executionStarted: false },
    );
    const text = renderLines(rendered, 120).join("\n");

    expect(text).toContain("▸ bash ·");
    expect(text).toContain("~/personal/pi-config");
    expect(text).toContain("$ pnpm test -- --runInBand");
    expect(text).toContain("timeout 9s");
    expect(args).toEqual({ command: "pnpm test -- --runInBand", timeout: 9, cwd: `${homedir()}/personal/pi-config` });
    expect(tool.renderResult).toBe(nativeRenderResultMock);
    expectWidthSafe(rendered);
  });

  it("places cwd on the header line and the command on its own line below", async () => {
    const { default: initBetterBashTool } = await import("../index.js");
    const mock = createMockPi();
    initBetterBashTool(mock.pi as never);

    const tool = mock.tools.get("bash") as {
      renderCall: (...args: unknown[]) => Renderable;
    };
    const ctx = { ...createMockContext(), cwd: process.cwd() };
    const args = deepFreeze({
      command: "pnpm test -- --runInBand",
      timeout: 9,
      cwd: `${homedir()}/personal/pi-config`,
    });

    const rendered = tool.renderCall(args, ctx.ui.theme, {
      cwd: ctx.cwd,
      state: {},
      executionStarted: false,
    });
    const lines = renderLines(rendered, 120).filter((line) => line.trim() !== "");

    const cwdLine = lines.find((line) => line.includes("~/personal/pi-config"));
    const cmdLine = lines.find((line) => line.includes("$ pnpm test -- --runInBand"));

    expect(cwdLine).toBeDefined();
    expect(cmdLine).toBeDefined();
    expect(cwdLine).not.toBe(cmdLine);
    expect(cwdLine).not.toContain("$ pnpm test -- --runInBand");
    expect(lines.indexOf(cwdLine as string)).toBeLessThan(lines.indexOf(cmdLine as string));
    expectWidthSafe(rendered);
  });

  it("omits cwd metadata cleanly when no cwd is given (no dangling separator)", async () => {
    const { default: initBetterBashTool } = await import("../index.js");
    const mock = createMockPi();
    initBetterBashTool(mock.pi as never);

    const tool = mock.tools.get("bash") as {
      renderCall: (...args: unknown[]) => Renderable;
    };
    const ctx = { ...createMockContext(), cwd: process.cwd() };
    const args = deepFreeze({ command: "ls -la" });

    const rendered = tool.renderCall(args, ctx.ui.theme, {
      cwd: ctx.cwd,
      state: {},
      executionStarted: false,
    });
    const header = renderLines(rendered, 120).find((line) => line.includes("bash")) ?? "";

    expect(header).toContain("$ ls -la");
    expect(header).not.toMatch(/·\s*$/);
    expectWidthSafe(rendered);
  });
});
