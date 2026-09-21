import { expect, it } from "vitest";

import { installFooterVisuals } from "../src/footer.js";

type FooterComponent = { dispose(): void; render(width: number): string[] };
type FooterFactory = (
  tui: { requestRender(): void },
  theme: { fg(color: string, text: string): string },
  footerData: {
    onBranchChange(callback: () => void): () => void;
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
    getAvailableProviderCount(): number;
  },
) => FooterComponent;
type EventHandler = (event: unknown, ctx: unknown) => Promise<void> | void;

it.each(["native", "off"])("counts child costs once with reportUsage=%s", async (reportUsage) => {
  const globals = globalThis as Record<symbol, unknown>;
  const keys = [Symbol.for("pi-subagents:manager"), Symbol.for("pi-visuals:footer"), Symbol.for("pi-goal:footer")];
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  let component: FooterComponent | undefined;

  try {
    globals[keys[0]] = { getLifetimeCost: () => 2 };
    delete globals[keys[2]];
    const handlers = new Map<string, EventHandler>();
    let footerFactory: FooterFactory | undefined;
    const pi = {
      getThinkingLevel: () => "off",
      on(event: string, handler: EventHandler): void {
        handlers.set(event, handler);
      },
    };
    const parentUsage = {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 1 },
    };
    const ctx = {
      hasUI: true,
      isIdle: () => true,
      cwd: "/workspace",
      model: undefined,
      getContextUsage: () => ({ contextWindow: 200_000, percent: 0 }),
      sessionManager: {
        getEntries: () => [
          { type: "message", message: { role: "assistant", usage: parentUsage } },
          {
            type: "message",
            message: {
              role: "toolResult", toolName: "Agent", toolCallId: "child-1",
              content: [{ type: "text", text: "Child completed" }], isError: false,
              ...(reportUsage === "native" ? {
                usage: { ...parentUsage, cost: { ...parentUsage.cost, input: 1, output: 1, total: 2 } },
              } : {}),
            },
          },
        ],
        getSessionName: () => undefined,
      },
      ui: {
        setFooter(factory: FooterFactory): void {
          footerFactory = factory;
        },
      },
    };

    installFooterVisuals(pi as never);
    await handlers.get("session_start")?.({}, ctx);
    component = footerFactory?.(
      { requestRender(): void {} },
      { fg: (_color, text) => text },
      {
        onBranchChange: () => () => {},
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 1,
      },
    );
    const footer = component?.render(200).join("\n") ?? "";
    expect(footer).toContain("$3.000");
    expect(footer).not.toContain("$5.000");
  } finally {
    component?.dispose();
    keys.forEach((key, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    });
  }
});
