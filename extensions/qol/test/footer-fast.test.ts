import { afterEach, describe, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { installFooterVisuals } from "../src/footer.js";

type FooterComponent = { dispose(): void; render(width: number): string[] };
type FooterFactory = (
  tui: { requestRender(): void },
  theme: { fg(color: string, text: string): string; getThinkingBorderColor(level: string): (text: string) => string },
  footerData: {
    onBranchChange(callback: () => void): () => void;
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
    getAvailableProviderCount(): number;
  },
) => FooterComponent;

async function createHarness(reasoning = true, thinking = "medium", hasModel = true) {
  const mock = createMockPi();
  mock.pi.getThinkingLevel = () => thinking;
  const statuses = new Map<string, string>();
  let factory: FooterFactory | undefined;
  const ctx = {
    hasUI: true, cwd: "/workspace", isIdle: () => true,
    model: hasModel ? { id: "model", provider: "provider", reasoning } : undefined,
    modelRegistry: { isUsingOAuth: () => false },
    getContextUsage: () => ({ contextWindow: 200_000, percent: 0 }),
    sessionManager: { getEntries: () => [], getSessionName: () => undefined },
    ui: { setFooter(value: FooterFactory) { factory = value; } },
  };
  // Exercise registration with the existing partial extension fixture.
  Reflect.apply(installFooterVisuals, undefined, [mock.pi]);
  await mock.fireLifecycle("session_start", {}, ctx);
  if (!factory) throw new TypeError("Footer factory was not registered");
  const effortStyle = vi.fn((text: string) => `\x1b[35m${text}\x1b[0m`);
  const thinkingColor = vi.fn((_level: string) => effortStyle);
  const fg = vi.fn((_color: string, text: string) => `\x1b[2m${text}\x1b[0m`);
  const component = factory(
    { requestRender() {} },
    { fg, getThinkingBorderColor: thinkingColor },
    {
      onBranchChange: () => () => {}, getGitBranch: () => null,
      getExtensionStatuses: () => statuses, getAvailableProviderCount: () => 1,
    },
  );
  return { statuses, ctx, component, thinkingColor, effortStyle, fg };
}

const ownerKey = Symbol.for("pi-visuals:footer");
const originalOwner = Object.getOwnPropertyDescriptor(globalThis, ownerKey);
afterEach(() => {
  if (originalOwner) Object.defineProperty(globalThis, ownerKey, originalOwner);
  else Reflect.deleteProperty(globalThis, ownerKey);
});

const plain = (component: FooterComponent) => component.render(200).map(stripVTControlCharacters).join("\n");

describe("QoL footer Fast presentation", () => {
  it("merges active Fast with effort hue and retains other statuses without duplication", async () => {
    const { statuses, component, thinkingColor, effortStyle, fg } = await createHarness();
    statuses.set("fast", "fast");
    statuses.set("agent-mode", "review");
    statuses.set("mcp", "MCP: 2 servers");
    const text = plain(component);
    expect(text).toContain("model · medium:fast");
    expect(text.match(/fast/g)).toHaveLength(1);
    expect(text).toContain("review");
    expect(text).toContain("MCP 2");
    expect(thinkingColor).toHaveBeenCalledWith("medium");
    expect(effortStyle).toHaveBeenCalledWith("medium");
    expect(fg).toHaveBeenCalledWith("dim", ":fast");
    component.dispose();
  });

  it("reads the changing status map on each render", async () => {
    const { statuses, component } = await createHarness();
    expect(plain(component)).toContain("model · medium");
    expect(plain(component)).not.toContain("fast");
    statuses.set("fast", "fast");
    expect(plain(component)).toContain("model · medium:fast");
    statuses.delete("fast");
    expect(plain(component)).not.toContain("fast");
    component.dispose();
  });

  it("retains off effort when Fast is active", async () => {
    const { statuses, component } = await createHarness(true, "off");
    statuses.set("fast", "fast");
    expect(plain(component)).toContain("model · off:fast");
    component.dispose();
  });

  it.each([true, false])("shows Fast without invented effort when hasModel=%s", async (hasModel) => {
    const { statuses, component, thinkingColor } = await createHarness(false, "medium", hasModel);
    statuses.set("fast", "fast");
    const text = plain(component);
    expect(text).toContain(`${hasModel ? "model" : "no-model"} · fast`);
    expect(text).not.toContain("medium");
    expect(text.match(/fast/g)).toHaveLength(1);
    expect(thinkingColor).not.toHaveBeenCalled();
    statuses.delete("fast");
    expect(plain(component)).not.toContain("fast");
    component.dispose();
  });

  it("fits ANSI-styled Unicode model and status text to terminal cells", async () => {
    const { statuses, ctx, component } = await createHarness();
    if (ctx.model) ctx.model.id = "模型👩‍💻é".repeat(20);
    statuses.set("fast", "fast");
    statuses.set("mode", "审阅👩‍💻é".repeat(20));
    for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
      for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    component.dispose();
  });
});
