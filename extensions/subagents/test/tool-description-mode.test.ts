// End-to-end test for `toolDescriptionMode` (#91): settings file → sanitize →
// applier → registration-time description pick. Instantiates the real extension
// with a mock pi (same pattern as print-mode.test.ts) inside a temp cwd, then
// inspects the registered Agent tool's description.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

const EXAMPLE_TEMPLATE = fileURLToPath(new URL("../examples/agent-tool-description.md", import.meta.url));

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const activeTools = ["Agent"];

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      getActiveTools: vi.fn(() => activeTools),
      events: {
        emit: vi.fn(),
        on: vi.fn(() => vi.fn()),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
    handlers,
    activeTools,
  };
}


describe("toolDescriptionMode", () => {
  let tmpDir: string;
  let hermeticAgentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let currentHandlers: Map<string, any>;
  let currentActiveTools: string[];

  function setup(settings?: Record<string, unknown>, beforeInstantiate?: () => void) {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-"));
    // Isolate global settings (getAgentDir / ~/.pi) so the dev's real
    // subagents.json can't leak into the "default is full" assertion.
    hermeticAgentDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = hermeticAgentDir;
    process.env.HOME = hermeticAgentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    if (settings) {
      writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify(settings));
    }
    beforeInstantiate?.();
    process.chdir(tmpDir);

    const { pi, tools, handlers, activeTools } = makePi();
    currentHandlers = handlers;
    currentActiveTools = activeTools;
    subagentsExtension(pi);
    shutdown = async () => {
      await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    };
    return tools;
  }

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(hermeticAgentDir, { recursive: true, force: true });
  });

  it.each(["full", "compact", "custom"])("advertises configured metadata in %s mode", (mode) => {
    const model = "anthropic/claude-sonnet-4-6:high:fast, openai-codex/gpt-5.5:medium, llama-swap/qwen:14b:low";
    const fixtures = [
      { name: "chain", fields: `model: ${model}\nbuiltin_tools: read,bash\nextension_tools: lsp,codegraph_*,vendor_*`, builtins: "read, bash", extensions: "lsp, codegraph_*, vendor_*" },
      { name: "inherit", fields: "", builtins: "all", extensions: "all available within runtime policy" },
      { name: "none", fields: "builtin_tools: none\nextension_tools: none", builtins: "none", extensions: "none" },
      { name: "isolated", fields: "isolated: true\nextension_tools: vendor_*", builtins: "all", extensions: "unavailable" },
      { name: "disabled", fields: "extensions: false\nextension_tools: vendor_*", builtins: "all", extensions: "unavailable" },
    ];
    const tools = setup({ toolDescriptionMode: mode }, () => {
      const dir = join(tmpDir, ".pi", "agents");
      mkdirSync(dir);
      for (const fixture of fixtures) {
        writeFileSync(join(dir, `${fixture.name}.md`), `---\ndescription: Fixture researcher. Further details.\n${fixture.fields}\n---\nResearch only.\n`);
      }
      if (mode === "custom") {
        writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), "{{typeList}}\nCOMPACT\n{{compactTypeList}}");
      }
    });
    const description: string = tools.get("Agent").description;
    const sections = mode === "custom" ? description.split("\nCOMPACT\n") : [description];
    for (const section of sections) {
      for (const fixture of fixtures) {
        const row = section.split("\n").find((line) => line.startsWith(`- ${fixture.name}:`));
        expect(row).toBeDefined();
        const metadata = new Map([...row?.matchAll(/\((Model chain|Built-in tools|Configured extension tools): ([^)]*)\)/g) ?? []].map((match) => [match[1], match[2]]));
        expect(metadata.get("Built-in tools")).toBe(fixture.builtins);
        expect(metadata.get("Configured extension tools")).toBe(fixture.extensions);
        expect(metadata.get("Model chain")).toBeUndefined();
        expect(row).not.toContain("claude-sonnet-4-6");
      }
    }
  });

  it("keeps one configured roster and no parameter roster", () => {
    const tools = setup({ toolDescriptionMode: "full" });
    const agent = tools.get("Agent");
    const description: string = agent.description;
    const parameterDescription: string = agent.parameters.properties.subagent_type.description;
    expect(description.match(/^- general-purpose:/gm)).toHaveLength(1);
    expect(parameterDescription).not.toContain("general-purpose");
    expect(parameterDescription).not.toContain("chengfeng");
  });

  it("replaces the current permitted-target hint as mode policy changes", async () => {
    const tools = setup({ toolDescriptionMode: "full" }, () => {
      const dir = join(tmpDir, ".pi", "agents");
      mkdirSync(dir);
      writeFileSync(join(dir, "alpha.md"), "---\ndescription: Alpha worker.\n---\nAlpha.\n");
      writeFileSync(join(dir, "beta.md"), "---\ndescription: Beta worker.\n---\nBeta.\n");
    });
    expect(tools.has("Agent")).toBe(true);
    let entries: unknown[] = [
      { type: "custom", customType: "agent-mode", data: { mode: "kuafu", delegationPolicy: { version: 1, allowDelegationTo: ["alpha"], disallowDelegationTo: [] } } },
    ];
    const ctx = { sessionManager: { getEntries: () => entries } };
    const beforeAgentStart = currentHandlers.get("before_agent_start");

    const first = await beforeAgentStart({ systemPrompt: "BASE" }, ctx);
    expect(first.systemPrompt.match(/<!-- subagents:delegation-policy -->/g)).toHaveLength(1);
    expect(first.systemPrompt).toContain("alpha");
    expect(first.systemPrompt).not.toContain("beta");
    const unchanged = await beforeAgentStart({ systemPrompt: first.systemPrompt }, ctx);
    expect(unchanged.systemPrompt).toBe(first.systemPrompt);

    entries = [
      { type: "custom", customType: "agent-mode", data: { mode: "fuxi", delegationPolicy: { version: 1, allowDelegationTo: ["beta"], disallowDelegationTo: [] } } },
    ];
    const second = await beforeAgentStart({ systemPrompt: first.systemPrompt }, ctx);
    expect(second.systemPrompt.match(/<!-- subagents:delegation-policy -->/g)).toHaveLength(1);
    expect(second.systemPrompt).toContain("beta");
    expect(second.systemPrompt).not.toContain("alpha");

    entries = [{ type: "custom", customType: "agent-mode", data: { mode: "fuxi" } }];
    const unresolved = await beforeAgentStart({ systemPrompt: second.systemPrompt }, ctx);
    expect(unresolved.systemPrompt).toContain("permitted delegation targets: none");

    currentActiveTools.length = 0;
    expect(await beforeAgentStart({ systemPrompt: "BASE" }, ctx)).toBeUndefined();
  });

  it("background guidance blocks instead of ending the turn", () => {
    const tools = setup({ toolDescriptionMode: "full" });
    const guidelines = tools.get("Agent").promptGuidelines.join("\n");
    expect(guidelines).not.toContain("Explore");
    expect(guidelines).not.toMatch(/\bgrep\b/);
    expect(guidelines).toContain("wait: true");
    expect(guidelines).toContain("never end your turn");
    const description: string = tools.get("Agent").description;
    expect(description).toContain("wait: true");
    expect(description).not.toContain("You will be notified when it completes");
  });

  it("defaults to the explicit full mode output", async () => {
    const tools = setup();
    const defaultDescription: string = tools.get("Agent").description;

    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "full" }));
    const explicit = makePi();
    subagentsExtension(explicit.pi);
    try {
      expect(defaultDescription).toBe(explicit.tools.get("Agent").description);
    } finally {
      await explicit.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    }
  });

  it("compact mode selects a distinct, smaller description", async () => {
    const tools = setup({ toolDescriptionMode: "compact" });
    const compactDescription: string = tools.get("Agent").description;

    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "full" }));
    const full = makePi();
    subagentsExtension(full.pi);
    try {
      const fullDescription: string = full.tools.get("Agent").description;
      expect(compactDescription).not.toBe(fullDescription);
      expect(compactDescription.length).toBeLessThan(fullDescription.length);
    } finally {
      await full.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    }
  });

  it("invalid mode in the settings file falls back to full mode", async () => {
    const tools = setup({ toolDescriptionMode: "tiny" });
    const invalidModeDescription: string = tools.get("Agent").description;

    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "full" }));
    const full = makePi();
    subagentsExtension(full.pi);
    try {
      expect(invalidModeDescription).toBe(full.tools.get("Agent").description);
    } finally {
      await full.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    }
  });

  it("custom mode renders the project template with placeholders substituted", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(
        join(tmpDir, ".pi", "agent-tool-description.md"),
        "My agents:\n{{typeList}}\n\nGlobal dir: {{agentDir}}\nUnknown: {{nope}}\nCost: $& stays literal",
      );
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("My agents:");
    expect(desc).toContain("- general-purpose:");
    expect(desc).toContain(`Global dir: ${hermeticAgentDir}`);
    expect(desc).toContain("Unknown: {{nope}}");
    expect(desc).toContain("Cost: $& stays literal");
  });

  it("custom mode falls back to the global file when no project file exists", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(hermeticAgentDir, "agent-tool-description.md"), "GLOBAL CUSTOM\n{{compactTypeList}}");
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("GLOBAL CUSTOM");
    expect(desc).not.toContain("{{compactTypeList}}");
    expect(desc).toContain("general-purpose");
  });


  it("every documented placeholder is replaced — no {{ }} residue", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(
        join(tmpDir, ".pi", "agent-tool-description.md"),
        "A {{typeList}} B {{compactTypeList}} C {{agentDir}} D",
      );
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).not.toContain("}{{");
    expect(desc).not.toContain("}}");
  })

  it("the shipped example template renders byte-identical to the full description", async () => {
    // Guards examples/agent-tool-description.md against going stale: it must
    // reproduce the full description exactly. If you edit one, edit the other.
    const example = readFileSync(EXAMPLE_TEMPLATE, "utf-8");
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), example);
    });
    const customDesc: string = tools.get("Agent").description;

    // Second instance in the same hermetic cwd, flipped to full mode.
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "full" }));
    const second = makePi();
    subagentsExtension(second.pi);
    try {
      expect(customDesc).toBe(second.tools.get("Agent").description);
    } finally {
      await second.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    }
  });

  it("custom mode without a file falls back to the full description with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tools = setup({ toolDescriptionMode: "custom" });
      const fallbackDescription: string = tools.get("Agent").description;

      writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "full" }));
      const full = makePi();
      subagentsExtension(full.pi);
      try {
        expect(fallbackDescription).toBe(full.tools.get("Agent").description);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("no agent-tool-description.md found"));
      } finally {
        await full.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("omits caller model and thinking overrides from the Agent tool", () => {
    const tools = setup({ toolDescriptionMode: "full" });
    const agent = tools.get("Agent");
    const properties = agent.parameters.properties as Record<string, unknown>;
    expect(properties).not.toHaveProperty("model");
    expect(properties).not.toHaveProperty("thinking");
    const description: string = agent.description;
    expect(description).not.toContain("Use model to");
    expect(description).not.toContain("Use thinking to");
  });
});
