import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  getAgentDirMock,
  sessionManagerInMemory,
  settingsManagerCreate,
  mockState,
} = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
  getAgentDirMock: vi.fn(() => "/mock/agent-dir"),
  sessionManagerInMemory: vi.fn(() => ({ kind: "memory-session-manager" })),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager" })),
  mockState: { agentDir: "/mock/agent-dir" },
}));

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession,
    DefaultResourceLoader: class {
      constructor(options: unknown) {
        defaultResourceLoaderCtor(options);
      }

      async reload() {}
    },
    getAgentDir: getAgentDirMock,
    SessionManager: { inMemory: sessionManagerInMemory },
    SettingsManager: { create: settingsManagerCreate },
  };
});

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../src/memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

import { registerAgents } from "../src/agent-types.js";
import { runAgent } from "../src/agent-runner.js";
import { loadCustomAgentsWithDiagnostics } from "../src/custom-agents.js";

const AGENT_NAME = "matrix-agent";
const AVAILABLE_TOOL_NAMES = [
  "read",
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "alpha.search",
  "alpha.search_plus",
  "beta.lookup",
  "custom_tool",
  "Agent",
  "get_subagent_result",
  "steer_subagent",
];

interface MatrixExtensionContext {
  cwd: ExtensionContext["cwd"];
  model: ExtensionContext["model"];
  modelRegistry: Pick<ExtensionContext["modelRegistry"], "find" | "getAvailable">;
  getSystemPrompt: ExtensionContext["getSystemPrompt"];
  sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">;
}

interface MatrixMessage {
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
}

function asExtensionContext(value: MatrixExtensionContext): ExtensionContext {
  return value as unknown as ExtensionContext;
}

function asExtensionAPI(value: Record<string, never>): ExtensionAPI {
  return value as unknown as ExtensionAPI;
}

const ctx = asExtensionContext({
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: { getBranch: vi.fn(() => []) },
});

const pi = asExtensionAPI({});

function createSession(finalText: string, activeToolNames = AVAILABLE_TOOL_NAMES) {
  const session = {
    messages: [] as MatrixMessage[],
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => activeToolNames),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  return session;
}

function writeAgent(cwd: string, frontmatter: string) {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${AGENT_NAME}.md`),
    `---\n${frontmatter.trim()}\n---\n\nMatrix regression agent.`,
  );
}

interface MatrixCase {
  name: string;
  frontmatter: string;
  expectedActiveToolNames: string[];
  expectedDiagnostics?: Array<{ field: string; severity: "warning" | "error"; message: string }>;
  runOptions?: { isolated?: boolean };
}

/**
 * Active-tool regression matrix.
 *
 * | Case | builtin_tools | extensions | extension_tools | isolated | allow_nesting | Expected runtime active tools |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | read-only built-ins | read | false | omitted | false | false | read |
 * | no built-ins + omitted extension_tools | none | true | omitted | false | false | all non-nested extension/custom names |
 * | extension_tools none | read,bash | true | none | false | false | read,bash |
 * | exact extension_tools filter | read | alpha CSV | alpha.search | false | false | read,alpha.search only |
 * | extensions false | read,bash | false | alpha.search | false | false | read,bash |
 * | isolated override | read | true | alpha.search | true | false | read |
 * | nesting denied | read | true | Agent/get/steer/alpha.search | false | false | read,alpha.search |
 * | nesting allowed | read | true | Agent/get/steer/alpha.search | false | true | read,alpha.search,Agent,get,steer |
 */
const matrix: MatrixCase[] = [
  {
    name: "read-only builtin_tools keeps only read and no extensions",
    frontmatter: "builtin_tools: read\nextensions: false",
    expectedActiveToolNames: ["read"],
  },
  {
    name: "builtin_tools none with extension_tools omitted enables all non-nested extension tools",
    frontmatter: "builtin_tools: none\nextensions: true",
    expectedActiveToolNames: ["alpha.search", "alpha.search_plus", "beta.lookup", "custom_tool"],
  },
  {
    name: "extension_tools none disables extension tools while keeping built-ins",
    frontmatter: "builtin_tools: read, bash\nextension_tools: none",
    expectedActiveToolNames: ["read", "bash"],
  },
  {
    name: "extension_tools CSV is an exact allowlist after extensions CSV enables extension tools",
    frontmatter: "builtin_tools: read\nextensions: alpha\nextension_tools: alpha.search",
    expectedActiveToolNames: ["read", "alpha.search"],
  },
  {
    name: "extensions false disables extension tools regardless of extension_tools",
    frontmatter: "builtin_tools: read, bash\nextensions: false\nextension_tools: alpha.search",
    expectedActiveToolNames: ["read", "bash"],
  },
  {
    name: "isolated override disables extension tools at runtime",
    frontmatter: "builtin_tools: read\nextensions: true\nextension_tools: alpha.search",
    runOptions: { isolated: true },
    expectedActiveToolNames: ["read"],
  },
  {
    name: "allow_nesting false removes nested subagent tools even when selected",
    frontmatter: "builtin_tools: read\nextensions: true\nextension_tools: Agent, get_subagent_result, steer_subagent, alpha.search",
    expectedActiveToolNames: ["read", "alpha.search"],
  },
  {
    name: "allow_nesting true permits selected nested subagent tools",
    frontmatter: "builtin_tools: read\nextensions: true\nextension_tools: Agent, get_subagent_result, steer_subagent, alpha.search\nallow_nesting: true",
    expectedActiveToolNames: ["read", "alpha.search", "Agent", "get_subagent_result", "steer_subagent"],
  },
];

describe("custom agent parser/runtime active-tool matrix", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-subagent-matrix-"));
    mockState.agentDir = join(tmpDir, "agent-dir");
    getAgentDirMock.mockImplementation(() => mockState.agentDir);
    createAgentSession.mockReset();
    defaultResourceLoaderCtor.mockClear();
    sessionManagerInMemory.mockClear();
    settingsManagerCreate.mockClear();
  });

  afterEach(() => {
    registerAgents(new Map());
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(matrix)("$name", async ({ frontmatter, expectedActiveToolNames, expectedDiagnostics = [], runOptions }) => {
    writeAgent(tmpDir, frontmatter);
    const { agents, diagnostics } = loadCustomAgentsWithDiagnostics(tmpDir);
    registerAgents(agents);

    expect(diagnostics.map(({ field, severity, message }) => ({ field, severity, message }))).toEqual(expectedDiagnostics);

    const session = createSession("MATRIX");
    createAgentSession.mockResolvedValueOnce({ session });

    await runAgent(ctx, AGENT_NAME, "Say MATRIX", { pi, ...runOptions });

    expect(createAgentSession.mock.calls[0][0]).not.toHaveProperty("tools");
    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(1);
    expect(session.setActiveToolsByName).toHaveBeenCalledWith(expectedActiveToolNames);
    const finalActiveToolNames = session.setActiveToolsByName.mock.calls[0][0] as string[];
    expect(new Set(finalActiveToolNames).size).toBe(finalActiveToolNames.length);

    if (runOptions?.isolated) {
      expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(expect.objectContaining({ noExtensions: true }));
    }
  });

  it("rejects obsolete denylist fields before runtime", () => {
    writeAgent(tmpDir, "builtin_tools: read\ndisallowed_tools: bash");

    const { agents, diagnostics } = loadCustomAgentsWithDiagnostics(tmpDir);

    expect(agents.has(AGENT_NAME)).toBe(false);
    expect(diagnostics.map(({ agentName, field, severity, message }) => ({ agentName, field, severity, message }))).toEqual([
      {
        agentName: AGENT_NAME,
        field: "disallowed_tools",
        severity: "error",
        message: "disallowed_tools is invalid/obsolete; use builtin_tools and extension_tools explicit allowlists instead.",
      },
    ]);
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("rejects legacy tools before runtime", () => {
    writeAgent(tmpDir, "tools: read, alpha.search, custom_tool, grep\nextensions: false");

    const { agents, diagnostics } = loadCustomAgentsWithDiagnostics(tmpDir);

    expect(agents.has(AGENT_NAME)).toBe(false);
    expect(diagnostics.map(({ agentName, field, severity, message }) => ({ agentName, field, severity, message }))).toEqual([
      {
        agentName: AGENT_NAME,
        field: "tools",
        severity: "error",
        message: "tools is invalid/obsolete; use builtin_tools for built-in tools and extension_tools for extension/custom tools instead.",
      },
    ]);
    expect(createAgentSession).not.toHaveBeenCalled();
  });
});
