import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it("shows session name alone, main repo name for a worktree, and cache hit rate", async () => {
  const root = mkdtempSync(join(tmpdir(), "qol-footer-"));
  const repo = join(root, "main-repo");
  const worktree = join(root, "wt-feature-dir");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
  const ownerKey = Symbol.for("pi-visuals:footer");
  const previousOwner = Object.getOwnPropertyDescriptor(globalThis, ownerKey);
  let component: FooterComponent | undefined;

  try {
    execFileSync("git", ["init", "-q", repo]);
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    git(repo, "worktree", "add", "-q", "-b", "feature", worktree);

    const handlers = new Map<string, EventHandler>();
    let footerFactory: FooterFactory | undefined;
    const pi = {
      getThinkingLevel: () => "off",
      on(event: string, handler: EventHandler): void {
        handlers.set(event, handler);
      },
    };
    const usage = {
      input: 42, output: 22_000, cacheRead: 1_700_000, cacheWrite: 156_000, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const ctx = {
      hasUI: true,
      isIdle: () => true,
      cwd: worktree,
      model: undefined,
      getContextUsage: () => ({ contextWindow: 200_000, percent: 0 }),
      sessionManager: {
        getEntries: () => [{ type: "message", message: { role: "assistant", usage } }],
        getSessionName: () => "Evaluating migration",
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
        getGitBranch: () => "feature",
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 1,
      },
    );
    const lines = component?.render(200) ?? [];
    expect(lines[0]).toBe("main-repo · feature");
    expect(lines[1]).toBe("Evaluating migration");
    // 1.7M / (42 + 1.7M + 156k) = 91.6%
    expect(lines[2]).toContain("cache 92%");
  } finally {
    component?.dispose();
    if (previousOwner) Object.defineProperty(globalThis, ownerKey, previousOwner);
    else delete (globalThis as Record<symbol, unknown>)[ownerKey];
    rmSync(root, { recursive: true, force: true });
  }
});
