import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { boot, dir, mockRunAgent } from "./graph-run-registration.fixture.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

describe("independent agent history lifecycle", () => {
  it("disables capture before reload abort, then shows the reloaded row as stopped", async () => {
    const host = boot();
    await host.lifecycle("session_start");
    const sessionFile = join(dir, "child.jsonl");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(sessionFile, "");
    let settled = false;
    mockRunAgent(async (_ctx, _type, _prompt, options) => {
      const session = {
        dispose: vi.fn(),
        subscribe: vi.fn(() => vi.fn()),
        sessionManager: { isPersisted: () => true, getSessionFile: () => sessionFile },
      };
      options?.onSessionCreated?.(session as never);
      await new Promise<void>(resolve => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      settled = true;
      return { responseText: "SECRET_RESULT", session, aborted: true, steered: false };
    });
    await host.tools.get("Agent")!.execute("call", {
      prompt: "SECRET_PROMPT",
      description: "history review",
      subagent_type: "general-purpose",
      run_in_background: true,
    }, undefined, undefined, host.ctx);
    const historyPath = join(dir, "global", "local", "parent", "agent-history.json");
    await vi.waitFor(async () => {
      expect(await readFile(historyPath, "utf8")).toContain('"status":"running"');
    });
    const before = await readFile(historyPath, "utf8");
    expect(before).not.toContain("SECRET_");
    await host.lifecycle("session_shutdown", { reason: "reload" });
    await vi.waitFor(() => expect(settled).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await readFile(historyPath, "utf8")).toBe(before);

    const next = boot();
    await next.lifecycle("session_start");
    const saved = JSON.parse(await readFile(historyPath, "utf8")) as { runs: Array<{ id: string }> };
    expect((globalThis as Record<symbol, { getRecord(id: string): unknown }>)[MANAGER_KEY].getRecord(saved.runs[0].id)).toBeUndefined();
    let rendered = "";
    next.ui.custom.mockImplementation(async (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => { render(width: number): string[]; dispose(): void }) => {
      const component = factory(
        { terminal: { rows: 40 }, requestRender: () => {} },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        {},
        () => {},
      );
      rendered = component.render(140).join("\n");
      component.dispose();
    });
    await next.commands.get("agent-monitor")!.handler("", next.ctx);
    expect(rendered).toContain("history review");
    expect(rendered).toContain("stopped");
  });
});
