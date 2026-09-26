import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { createAgentsMenu } from "../src/ui/agents-menu.js";

const FIXTURE = [
  JSON.stringify({ type: "session", version: 3, id: "child", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/tmp" }),
  JSON.stringify({
    type: "message", id: "m1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "VISIBLE_HISTORY" }], timestamp: 1700000000000 },
  }),
].join("\n") + "\n";

function historyRecord(sessionFile: string): AgentRecord {
  return {
    id: "hist-1",
    type: "general-purpose",
    description: "history review",
    status: "running",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    sessionFile,
  };
}

describe("agent history conversation", () => {
  let root: string;
  const manager = new AgentManager();
  const menu = createAgentsMenu(
    { pi: {} as never, manager, reloadCustomAgents: () => {} },
    new Map(),
    {
      agentGraphEnabled: false,
      graphRuns: { tasks: new Map(), getRecord: () => undefined, viewAgentConversation: async () => {}, getCtx: () => undefined },
      showSettings: async () => {},
    },
  );
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("opens a read-only viewer for a history record and notifies when the file is gone", async () => {
    root = await mkdtemp(join(tmpdir(), "agent-history-menu-"));
    const sessionFile = join(root, "child.jsonl");
    await writeFile(sessionFile, FIXTURE);
    let rendered = "";
    const custom = async (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => { render(width: number): string[]; dispose(): void }) => {
      const viewer = factory(
        { terminal: { rows: 40 }, requestRender: () => {} },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        {},
        () => {},
      );
      rendered = viewer.render(80).join("\n");
      viewer.dispose();
    };
    const notify = { calls: [] as unknown[][], fn: (...args: unknown[]) => { notify.calls.push(args); } };
    await menu.viewAgentConversation({ ui: { custom, notify: notify.fn } } as never, historyRecord(sessionFile));
    expect(rendered).toContain("VISIBLE_HISTORY");
    expect(rendered).not.toContain("x stop");
    expect(rendered).not.toContain("Enter steer");
    rendered = "";
    await menu.viewAgentConversation({ ui: { custom, notify: notify.fn } } as never, historyRecord(join(root, "missing.jsonl")));
    expect(rendered).toBe("");
    expect(notify.calls).toContainEqual([`Conversation file is missing: ${join(root, "missing.jsonl")}`, "info"]);
  });

  it("warns when a history file is not a Pi session", async () => {
    root = await mkdtemp(join(tmpdir(), "agent-history-menu-"));
    const bad = join(root, "bad.jsonl");
    await writeFile(bad, "not-json\n");
    const notify = { calls: [] as unknown[][], fn: (...args: unknown[]) => { notify.calls.push(args); } };
    await menu.viewAgentConversation({ ui: { custom: async () => {}, notify: notify.fn } } as never, historyRecord(bad));
    expect(notify.calls).toEqual([[`Conversation file is not a Pi session: ${bad}`, "warning"]]);
  });

  it("warns when a history file is unreadable", async () => {
    root = await mkdtemp(join(tmpdir(), "agent-history-menu-"));
    const dir = join(root, "x.jsonl");
    await mkdir(dir);
    const notify = { calls: [] as unknown[][], fn: (...args: unknown[]) => { notify.calls.push(args); } };
    await menu.viewAgentConversation({ ui: { custom: async () => {}, notify: notify.fn } } as never, historyRecord(dir));
    expect(notify.calls).toEqual([[`Conversation file is unreadable (EISDIR): ${dir}`, "warning"]]);
  });

  it("replaces the home directory only at a path-segment boundary", async () => {
    const home = homedir();
    const under = join(home, "pi-config-agent-history-missing.jsonl");
    const sibling = join(`${home}2`, "missing.jsonl");
    const notify = { calls: [] as unknown[][], fn: (...args: unknown[]) => { notify.calls.push(args); } };
    const ui = { ui: { custom: async () => {}, notify: notify.fn } } as never;
    await menu.viewAgentConversation(ui, historyRecord(under));
    await menu.viewAgentConversation(ui, historyRecord(sibling));
    expect(notify.calls).toEqual([
      [`Conversation file is missing: ~${sep}pi-config-agent-history-missing.jsonl`, "info"],
      [`Conversation file is missing: ${sibling}`, "info"],
    ]);
  });
});
