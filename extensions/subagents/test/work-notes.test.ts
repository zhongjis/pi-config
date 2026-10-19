import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSession, loaderOptions } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  loaderOptions: [] as Array<{ systemPromptOverride?: () => string }>,
}));

// Real runner and manager; only session construction is faked so the child system prompt is observable.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: (typeof loaderOptions)[number]) { loaderOptions.push(options); }
    async reload() {}
  },
  SessionManager: { create: () => ({ appendCustomEntry: vi.fn(), getSessionId: () => "child-session" }) },
  SettingsManager: { create: () => ({ getSessionDir: () => undefined }) },
}));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

import { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import type { AccessRule } from "../../lib/active-tools.js";
import type { AgentConfig } from "../src/types.js";
import { workNotesSuffix } from "../src/work-notes.js";

const ctx = {
  cwd: tmpdir(),
  model: { provider: "fixture", id: "parent" },
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: () => "PARENT PROMPT",
  sessionManager: { getBranch: () => [], getSessionId: () => "parent-session", getSessionFile: () => undefined },
} as any;
const pi = {} as any;

function fakeSession() {
  const session = {
    messages: [] as any[],
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => {
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" });
    }),
    waitForIdle: vi.fn(async () => {}),
    abort: vi.fn(),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return session;
}

function agent(name: string, toolRules: AccessRule[]): AgentConfig {
  return {
    name,
    description: name,
    extensionRules: [],
    toolRules,
    discoverSkills: false,
    preloadSkills: [],
    systemPrompt: "AGENT PROMPT",
    promptMode: "replace",
  };
}

const writer = agent("writer", [{ sign: "+", selector: "@all" }]);
const reader = agent("reader", [{ sign: "+", selector: "@all" }, { sign: "-", selector: "@builtin" }, { sign: "+", selector: "read" }]);
const lastPrompt = () => loaderOptions.at(-1)?.systemPromptOverride?.() ?? "";

let manager: AgentManager;

beforeEach(() => {
  createAgentSession.mockReset();
  createAgentSession.mockImplementation(async () => ({ session: fakeSession() }));
  loaderOptions.length = 0;
  registerAgents(new Map([["writer", writer], ["reader", reader]]));
  manager = new AgentManager();
});

afterEach(async () => {
  await manager.dispose();
  registerAgents(new Map());
});

describe("work notes", () => {
  it("gives a writing agent its own notes file in the shared local:// root", async () => {
    const { record } = await manager.spawnAndWait(pi, ctx, "writer", "go", { description: "writer" });

    expect(lastPrompt()).toContain("<work_notes>");
    expect(lastPrompt()).toContain(`local://notes/${record.id}.md`);
    expect(record.notesFile).toMatch(new RegExp(`/parent-session/notes/${record.id}\\.md$`));
  });

  it("skips read-only and isolated agents", async () => {
    const { record: readOnly } = await manager.spawnAndWait(pi, ctx, "reader", "go", { description: "reader" });
    expect(lastPrompt()).not.toContain("<work_notes>");
    expect(readOnly.notesFile).toBeUndefined();

    const { record: isolated } = await manager.spawnAndWait(pi, ctx, "writer", "go", { description: "writer", isolated: true });
    expect(lastPrompt()).not.toContain("<work_notes>");
    expect(isolated.notesFile).toBeUndefined();
  });

  it("points results at the notes only once the file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "work-notes-"));
    try {
      const notesFile = join(dir, "abc.md");
      expect(workNotesSuffix({ id: "abc", notesFile })).toBe("");
      expect(workNotesSuffix({ id: "abc" })).toBe("");
      writeFileSync(notesFile, "- step 1\n");
      expect(workNotesSuffix({ id: "abc", notesFile })).toBe("\n\nWork notes: local://notes/abc.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
