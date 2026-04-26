import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
  const defaultAgentConfig = () => ({
    name: "general-purpose",
    description: "Mock agent",
    systemPrompt: "",
    promptMode: "append" as const,
    extensions: false as true | string[] | false,
    skills: false as true | string[] | false,
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  });
  const defaultTypeConfig = () => ({
    displayName: "General Purpose",
    description: "Mock agent",
    builtinToolNames: ["read", "grep"],
    extensions: false as true | string[] | false,
    skills: false as true | string[] | false,
    promptMode: "append" as const,
  });

  return {
    createAgentSession: vi.fn(),
    defaultAgentConfig,
    defaultTypeConfig,
    agentConfig: defaultAgentConfig(),
    typeConfig: defaultTypeConfig(),
    tools: [
      { name: "read" },
      { name: "read" },
      { name: "grep" },
    ],
  };
});

const createAgentSessionMock = mockState.createAgentSession;

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: mockState.createAgentSession,
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
  getAgentConfig: vi.fn(() => mockState.agentConfig),
  getConfig: vi.fn(() => mockState.typeConfig),
  getMemoryTools: vi.fn(() => []),
  getReadOnlyMemoryTools: vi.fn(() => []),
  getToolsForType: vi.fn(() => mockState.tools),
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

function createSession(activeTools = ["read", "grep"]) {
  const messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [];
  return {
    messages,
    subscribe: vi.fn(() => () => {}),
    bindExtensions: vi.fn(async () => {}),
    prompt: vi.fn(async () => {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      });
    }),
    getActiveToolNames: vi.fn(() => activeTools),
    setActiveToolsByName: vi.fn(),
    abort: vi.fn(),
    steer: vi.fn(async () => {}),
  };
}

async function runWithSession(session: ReturnType<typeof createSession>) {
  createAgentSessionMock.mockResolvedValue({ session });
  return runAgent(
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
}

describe("runAgent", () => {
  beforeEach(() => {
    createAgentSessionMock.mockReset();
    mockState.agentConfig = mockState.defaultAgentConfig();
    mockState.typeConfig = mockState.defaultTypeConfig();
  });

  it("passes tool-name allowlists to createAgentSession", async () => {
    const session = createSession();

    const result = await runWithSession(session);

    expect(result.responseText).toBe("done");
    expect(createAgentSessionMock).toHaveBeenCalledOnce();
    expect(createAgentSessionMock.mock.calls[0]?.[0]?.tools).toEqual(["read", "grep"]);
    expect(createAgentSessionMock.mock.calls[0]?.[0]?.tools.every((tool: unknown) => typeof tool === "string")).toBe(true);
  });

  it("filters readonly_bash from inherited extension tools only", async () => {
    mockState.typeConfig = { ...mockState.defaultTypeConfig(), extensions: true };
    const session = createSession(["read", "grep", "readonly_bash", "web_search", "clauderock"]);

    await runWithSession(session);

    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "grep", "web_search", "clauderock"]);
  });

  it("exposes readonly_bash when exactly allowlisted", async () => {
    mockState.typeConfig = { ...mockState.defaultTypeConfig(), extensions: ["readonly_bash"] };
    const session = createSession(["read", "grep", "readonly_bash", "web_search"]);

    await runWithSession(session);

    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "grep", "readonly_bash"]);
  });

  it("does not expose readonly_bash for partial extension allowlist matches", async () => {
    mockState.typeConfig = { ...mockState.defaultTypeConfig(), extensions: ["readonly"] };
    const session = createSession(["read", "grep", "readonly_bash"]);

    await runWithSession(session);

    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "grep"]);
  });
});
