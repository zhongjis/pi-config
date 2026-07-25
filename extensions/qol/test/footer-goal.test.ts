import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Goal } from "../../goal/src/goal/types.js";
import { updateGoalUi } from "../../goal/src/goal/ui.js";
import { installFooterVisuals } from "../src/footer.js";

type FooterComponent = { dispose(): void; render(width: number): string[] };
type FooterFactory = (
  tui: { requestRender(): void },
  theme: { fg(color: string, text: string): string },
  footerData: {
    onBranchChange(callback: () => void): () => void;
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
  },
) => FooterComponent;
type EventHandler = (event: unknown, ctx: unknown) => Promise<void> | void;

describe("qol goal footer integration", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-visuals:footer")];
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-goal:footer")];
  });

  it("keeps qol as sole owner while composite renders advance busy time, freeze idle, and precede LSP", async () => {
    const handlers = new Map<string, EventHandler>();
    let footerFactory: FooterFactory | undefined;
    let footerInstallCount = 0;
    let idle = false;
    const pi = {
      getThinkingLevel: () => "off",
      on(event: string, handler: EventHandler): void {
        handlers.set(event, handler);
      },
    };
    const ctx = {
      hasUI: true,
      isIdle: () => idle,
      cwd: "/workspace",
      model: undefined,
      modelRegistry: { isUsingOAuth: () => false },
      getContextUsage: () => ({ contextWindow: 200_000, percent: 0 }),
      sessionManager: {
        getEntries: () => [],
        getSessionName: () => undefined,
      },
      ui: {
        setWidget(): void {},
        setStatus(): void {},
        setFooter(factory: FooterFactory): void {
          footerInstallCount += 1;
          footerFactory = factory;
        },
      },
    };
    const goal: Goal = {
      id: "composite-goal",
      threadId: "thread-1",
      objective: "prove composite render semantics",
      status: "active",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 0,
      updatedAt: 0,
    };

    installFooterVisuals(pi as never);
    await handlers.get("session_start")?.({}, ctx);
    updateGoalUi(ctx as never, goal);

    expect(footerInstallCount).toBe(1);
    const component = footerFactory?.(
      { requestRender(): void {} },
      { fg: (_color, text) => text },
      {
        onBranchChange: () => () => {},
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map([["lsp", "LSP 1/2 running"]]),
      },
    );

    const initialFooter = component?.render(80).join("\n") ?? "";
    expect(initialFooter).toContain("Pursuing goal (0s)");
    expect(initialFooter.indexOf("Pursuing goal")).toBeLessThan(initialFooter.indexOf("LSP 1/2"));

    vi.setSystemTime(5_000);
    expect(component?.render(80).join("\n")).toContain("Pursuing goal (5s)");

    idle = true;
    vi.setSystemTime(10_000);
    expect(component?.render(80).join("\n")).toContain("Pursuing goal (5s)");
    vi.setSystemTime(15_000);
    expect(component?.render(80).join("\n")).toContain("Pursuing goal (5s)");

    component?.dispose();
  });

  it("keeps rendering LSP when stale goal idle state throws", async () => {
    const handlers = new Map<string, EventHandler>();
    let footerFactory: FooterFactory | undefined;
    const pi = {
      getThinkingLevel: () => "off",
      on(event: string, handler: EventHandler): void {
        handlers.set(event, handler);
      },
    };
    const ctx = {
      hasUI: true,
      isIdle: () => false,
      cwd: "/workspace",
      model: undefined,
      modelRegistry: { isUsingOAuth: () => false },
      getContextUsage: () => ({ contextWindow: 200_000, percent: 0 }),
      sessionManager: {
        getEntries: () => [],
        getSessionName: () => undefined,
      },
      ui: {
        setWidget(): void {},
        setStatus(): void {},
        setFooter(factory: FooterFactory): void {
          footerFactory = factory;
        },
      },
    };
    const goal: Goal = {
      id: "stale-footer-goal",
      threadId: "thread-1",
      objective: "keep stale footer rendering",
      status: "active",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 0,
      updatedAt: 0,
    };

    installFooterVisuals(pi as never);
    await handlers.get("session_start")?.({}, ctx);
    updateGoalUi(ctx as never, goal);
    ctx.isIdle = () => {
      throw new Error("stale context");
    };
    const component = footerFactory?.(
      { requestRender(): void {} },
      { fg: (_color, text) => text },
      {
        onBranchChange: () => () => {},
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map([["lsp", "LSP 1/2 running"]]),
      },
    );

    let rendered: string[] | undefined;
    expect(() => {
      rendered = component?.render(80);
    }).not.toThrow();
    const footer = rendered?.join("\n") ?? "";
    expect(footer).not.toContain("Pursuing goal");
    expect(footer).toContain("LSP 1/2");

    component?.dispose();
  });
});
