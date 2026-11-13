import { describe, expect, it } from "vitest";

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

async function renderStatusLine(statuses: Map<string, string>): Promise<string> {
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
    isIdle: () => true,
    cwd: "/workspace",
    model: undefined,
    modelRegistry: { isUsingOAuth: () => false },
    getContextUsage: () => ({ contextWindow: 200_000, percent: 0 }),
    sessionManager: { getEntries: () => [], getSessionName: () => undefined },
    ui: {
      setFooter(factory: FooterFactory): void {
        footerFactory = factory;
      },
    },
  };

  installFooterVisuals(pi as never);
  await handlers.get("session_start")?.({}, ctx);
  const component = footerFactory?.(
    { requestRender(): void {} },
    { fg: (_color, text) => text },
    {
      onBranchChange: () => () => {},
      getGitBranch: () => null,
      getExtensionStatuses: () => statuses,
      getAvailableProviderCount: () => 1,
    },
  );
  const lines = component?.render(100) ?? [];
  component?.dispose();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-visuals:footer")];
  return lines[lines.length - 1] ?? "";
}

describe("qol background-tasks footer integration", () => {
  it("right-aligns the running bg task count before LSP and drops the left copy", async () => {
    const line = await renderStatusLine(
      new Map([
        ["agent-mode", "Kua Fu (build)"],
        ["background-tasks", "◉ 1 task running"],
        ["lsp", "LSP 1/2 running"],
      ]),
    );

    expect(line.startsWith("Kua Fu (build)  ")).toBe(true);
    expect(line).not.toContain("task running");
    expect(line.trimEnd().endsWith("◉ 1 bg task · LSP 1/2")).toBe(true);
  });

  it("pluralizes multiple bg tasks", async () => {
    const line = await renderStatusLine(new Map([["background-tasks", "◉ 3 tasks running"]]));

    expect(line.trim()).toBe("◉ 3 bg tasks");
  });

  it("renders nothing for bg tasks when the status is cleared", async () => {
    const line = await renderStatusLine(new Map([["agent-mode", "Kua Fu (build)"]]));

    expect(line).toBe("Kua Fu (build)");
  });
});
