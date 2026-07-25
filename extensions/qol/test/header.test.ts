import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import headerExtension from "../src/header.js";

type HeaderComponent = {
  render(width: number): string[];
};

type HeaderFactory = (
  tui: unknown,
  theme: { fg(color: string, text: string): string },
) => HeaderComponent;

type HeaderContext = {
  hasUI: boolean;
  cwd: string;
  model?: { id: string };
  ui: {
    setHeader(factory: HeaderFactory): void;
  };
};

type EventHandler = (
  event: unknown,
  ctx: HeaderContext,
) => unknown | Promise<unknown>;

const plainTheme = {
  fg: (_color: string, text: string) => text,
};

function createHarness() {
  const handlers = new Map<string, EventHandler>();
  const headerFactories: HeaderFactory[] = [];
  const exec = vi.fn().mockResolvedValue({
    code: 0,
    stdout: "feature/qol-tests\n",
  });
  const getCommands = vi.fn(() => [
    { source: "skill" },
    { source: "skill" },
    { source: "prompt" },
    { source: "extension", sourceInfo: { path: "/extensions/alpha" } },
  ]);
  const getActiveTools = vi.fn(() => ["read", "write", "bash"]);
  const getAllTools = vi.fn(() => [
    { sourceInfo: { source: "builtin", path: "/builtin/read" } },
    { sourceInfo: { source: "extension", path: "/extensions/alpha" } },
    { sourceInfo: { source: "extension", path: "/extensions/beta" } },
    { sourceInfo: { source: "sdk", path: "/sdk/tool" } },
  ]);
  const setHeader = vi.fn((factory: HeaderFactory) => {
    headerFactories.push(factory);
  });

  headerExtension({
    on(event: string, handler: EventHandler): void {
      handlers.set(event, handler);
    },
    exec,
    getCommands,
    getActiveTools,
    getAllTools,
  } as never);

  const ctx: HeaderContext = {
    hasUI: true,
    cwd: "/workspace/qol",
    model: { id: "model-initial" },
    ui: { setHeader },
  };

  return {
    ctx,
    exec,
    getActiveTools,
    getAllTools,
    getCommands,
    handlers,
    headerFactories,
    setHeader,
  };
}

function renderHeader(factory: HeaderFactory, width: number): string[] {
  return factory({}, plainTheme).render(width);
}

describe("header extension characterization", () => {
  it("registers session_start and model_select handlers", () => {
    const { handlers } = createHarness();

    expect([...handlers.keys()]).toEqual(["session_start", "model_select"]);
  });

  it("does not execute git, count resources, or install a header without UI", async () => {
    const harness = createHarness();
    const noUiCtx = { ...harness.ctx, hasUI: false };

    await harness.handlers.get("session_start")?.({}, noUiCtx);
    await harness.handlers.get("model_select")?.({}, noUiCtx);

    expect(harness.exec).not.toHaveBeenCalled();
    expect(harness.getCommands).not.toHaveBeenCalled();
    expect(harness.getActiveTools).not.toHaveBeenCalled();
    expect(harness.getAllTools).not.toHaveBeenCalled();
    expect(harness.setHeader).not.toHaveBeenCalled();
  });

  it("refreshes branch and resource counts on session start, then installs a width-safe header", async () => {
    const harness = createHarness();

    await harness.handlers.get("session_start")?.({}, harness.ctx);

    expect(harness.exec).toHaveBeenCalledOnce();
    expect(harness.exec).toHaveBeenCalledWith(
      "git",
      ["branch", "--show-current"],
      { cwd: "/workspace/qol", timeout: 2000 },
    );
    expect(harness.getCommands).toHaveBeenCalledOnce();
    expect(harness.getActiveTools).toHaveBeenCalledOnce();
    expect(harness.getAllTools).toHaveBeenCalledOnce();
    expect(harness.setHeader).toHaveBeenCalledOnce();

    const factory = harness.headerFactories[0];
    expect(factory).toBeDefined();
    const rendered = renderHeader(factory, 120).join("\n");
    expect(rendered).toContain("model   model-initial");
    expect(rendered).toContain("dir     /workspace/qol");
    expect(rendered).toContain("branch  feature/qol-tests");
    expect(rendered).toContain("3 tools  2 skills  1 prompts  2 extensions");

    for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
      for (const line of renderHeader(factory, width)) {
        expect(visibleWidth(line), `${JSON.stringify(line)} at width ${width}`)
          .toBeLessThanOrEqual(width);
      }
    }
  });

  it("renders the no-git branch path when git lookup fails", async () => {
    const harness = createHarness();
    harness.exec.mockRejectedValueOnce(new Error("git unavailable"));

    await expect(
      harness.handlers.get("session_start")?.({}, harness.ctx),
    ).resolves.toBeUndefined();

    expect(renderHeader(harness.headerFactories[0], 120).join("\n"))
      .toContain("branch  no git");
  });

  it("reinstalls for model selection without refreshing branch or resource counts", async () => {
    const harness = createHarness();
    await harness.handlers.get("session_start")?.({}, harness.ctx);
    harness.exec.mockClear();
    harness.getCommands.mockClear();
    harness.getActiveTools.mockClear();
    harness.getAllTools.mockClear();
    harness.setHeader.mockClear();
    harness.headerFactories.length = 0;
    const selectedCtx = {
      ...harness.ctx,
      model: { id: "model-selected" },
    };

    await harness.handlers.get("model_select")?.({}, selectedCtx);

    expect(harness.exec).not.toHaveBeenCalled();
    expect(harness.getCommands).not.toHaveBeenCalled();
    expect(harness.getActiveTools).not.toHaveBeenCalled();
    expect(harness.getAllTools).not.toHaveBeenCalled();
    expect(harness.setHeader).toHaveBeenCalledOnce();
    const rendered = renderHeader(harness.headerFactories[0], 120).join("\n");
    expect(rendered).toContain("model   model-selected");
    expect(rendered).toContain("branch  feature/qol-tests");
    expect(rendered).toContain("3 tools  2 skills  1 prompts  2 extensions");
  });
});
