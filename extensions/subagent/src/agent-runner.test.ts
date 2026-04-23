import { describe, expect, it, vi } from "vitest";

const createAgentSessionMock = vi.fn();

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: createAgentSessionMock,
  DefaultResourceLoader: class {
    async reload() {}
  },
  getAgentDir: vi.fn(() => "/mock-agent-dir"),
  SessionManager: {
    inMemory: vi.fn(() => ({ kind: "session-manager" })),
  },
  SettingsManager: {
    create: vi.fn(() => ({ kind: "settings-manager" })),
  },
}));

vi.mock("./agent-types.js", () => ({
  getAgentConfig: vi.fn(() => ({
    name: "general-purpose",
    description: "Mock agent",
    systemPrompt: "",
    promptMode: "append",
    extensions: false,
    skills: false,
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  })),
  getConfig: vi.fn(() => ({
    displayName: "General Purpose",
    description: "Mock agent",
    builtinToolNames: ["read", "grep"],
    extensions: false,
    skills: false,
    promptMode: "append",
  })),
  getMemoryTools: vi.fn(() => []),
  getReadOnlyMemoryTools: vi.fn(() => []),
  getToolsForType: vi.fn(() => [
    { name: "read" },
    { name: "read" },
    { name: "grep" },
  ]),
}));

vi.mock("./context.js", () => ({
  buildParentContext: vi.fn(() => ""),
  extractText: vi.fn((content: unknown) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part: any) => (part?.type === "text" ? part.text ?? "" : ""))
      .join("");
  }),
}));

vi.mock("./env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: true, branch: "main", platform: "linux" })),
}));

vi.mock("./memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

vi.mock("./prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("./skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

const { runAgent } = await import("./agent-runner.js");

describe("runAgent", () => {
  it("passes tool-name allowlists to createAgentSession", async () => {
    const session = {
      messages: [] as Array<{ role: string; content: Array<{ type: string; text: string }> }>,
      subscribe: vi.fn(() => () => {}),
      bindExtensions: vi.fn(async () => {}),
      prompt: vi.fn(async () => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        });
      }),
      getActiveToolNames: vi.fn(() => ["read", "grep"]),
      setActiveToolsByName: vi.fn(),
      abort: vi.fn(),
      steer: vi.fn(async () => {}),
    };

    createAgentSessionMock.mockResolvedValue({ session });

    const result = await runAgent(
      {
        cwd: process.cwd(),
        model: undefined,
        modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
        getSystemPrompt: () => "parent prompt",
      } as any,
      "general-purpose",
      "Test prompt",
      {
        pi: {} as any,
      },
    );

    expect(result.responseText).toBe("done");
    expect(createAgentSessionMock).toHaveBeenCalledOnce();
    expect(createAgentSessionMock.mock.calls[0]?.[0]?.tools).toEqual(["read", "grep"]);
    expect(createAgentSessionMock.mock.calls[0]?.[0]?.tools.every((tool: unknown) => typeof tool === "string")).toBe(true);
  });
});
