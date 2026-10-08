// End-to-end test for `toolDescriptionMode` (#91): settings file → sanitize →
// applier → registration-time description pick. Instantiates the real extension
// with a mock pi (same pattern as print-mode.test.ts) inside a temp cwd, then
// inspects the registered `agent` tool's description.

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
  const activeTools = ["agent"];

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
      { name: "chain", fields: `model: ${model}\ntools: +read, +bash, +@lsp, +codegraph_*`, tools: "+read, +bash, +@lsp, +codegraph_*" },
      { name: "inherit", fields: "", tools: "none" },
      { name: "list", fields: "tools:\n  - +@all\n  - -edit", tools: "+@all, -edit" },
      { name: "isolated", fields: "isolated: true\ntools: +@builtin", tools: "+@builtin", isolated: "built-in tools only" },
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
    const description: string = tools.get("agent").description;
    const sections = mode === "custom" ? description.split("\nCOMPACT\n") : [description];
    for (const section of sections) {
      for (const fixture of fixtures) {
        const row = section.split("\n").find((line) => line.startsWith(`- ${fixture.name}:`));
        expect(row).toBeDefined();
        const metadata = new Map([...row?.matchAll(/\((tools|isolated): ([^)]*)\)/g) ?? []].map((match) => [match[1], match[2]]));
        expect(metadata.get("tools")).toBe(fixture.tools);
        expect(metadata.get("isolated")).toBe(fixture.isolated);
      }
    }
  });

  const policy = (mode: string, allow: string[]) => ({ mode, delegationPolicy: { version: 1, allowDelegationTo: allow, disallowDelegationTo: [] } });
  it.each([
    { name: "kuafu allows alpha", data: policy("kuafu", ["alpha"]), active: true, present: ["alpha"], absent: ["beta"] },
    { name: "fuxi allows beta", data: policy("fuxi", ["beta"]), active: true, present: ["beta"], absent: ["alpha"] },
    { name: "no policy permits none", data: { mode: "fuxi" }, active: true, present: ["none"], absent: ["alpha", "beta"] },
    { name: "inactive agent tool sets no section", data: policy("kuafu", ["alpha"]), active: false, present: [], absent: [] },
  ])("sets the subagents prompt section for mode policy: $name", async ({ data, active, present, absent }) => {
    setup({ toolDescriptionMode: "full" }, () => {
      const dir = join(tmpDir, ".pi", "agents");
      mkdirSync(dir);
      writeFileSync(join(dir, "alpha.md"), "---\ndescription: Alpha worker.\n---\nAlpha.\n");
      writeFileSync(join(dir, "beta.md"), "---\ndescription: Beta worker.\n---\nBeta.\n");
    });
    if (!active) currentActiveTools.length = 0;
    const ctx = { sessionManager: { getEntries: () => [{ type: "custom", customType: "agent-mode", data }] } };
    const sections: Record<string, string> = { other: "kept" };
    const result = await currentHandlers.get("before_agent_start")({ systemPrompt: "BASE", systemPromptOptions: { sections } }, ctx);
    expect(result).toBeUndefined();
    expect(sections.other).toBe("kept");
    if (!active) expect(sections.subagents).toBeUndefined();
    for (const name of present) expect(sections.subagents).toContain(name);
    for (const name of absent) expect(sections.subagents).not.toContain(name);
  });

  it("defaults to the explicit full mode output", async () => {
    const tools = setup();
    const defaultDescription: string = tools.get("agent").description;

    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "full" }));
    const explicit = makePi();
    subagentsExtension(explicit.pi);
    try {
      expect(defaultDescription).toBe(explicit.tools.get("agent").description);
    } finally {
      await explicit.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    }
  });

  it("compact mode selects a distinct, smaller description", async () => {
    const tools = setup({ toolDescriptionMode: "compact" });
    const compactDescription: string = tools.get("agent").description;

    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "full" }));
    const full = makePi();
    subagentsExtension(full.pi);
    try {
      const fullDescription: string = full.tools.get("agent").description;
      expect(compactDescription).not.toBe(fullDescription);
      expect(compactDescription.length).toBeLessThan(fullDescription.length);
    } finally {
      await full.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    }
  });

  it("invalid mode in the settings file falls back to full mode", async () => {
    const tools = setup({ toolDescriptionMode: "tiny" });
    const invalidModeDescription: string = tools.get("agent").description;

    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "full" }));
    const full = makePi();
    subagentsExtension(full.pi);
    try {
      expect(invalidModeDescription).toBe(full.tools.get("agent").description);
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
    const desc: string = tools.get("agent").description;
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
    const desc: string = tools.get("agent").description;
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
    const desc: string = tools.get("agent").description;
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
    const customDesc: string = tools.get("agent").description;

    // Second instance in the same hermetic cwd, flipped to full mode.
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "full" }));
    const second = makePi();
    subagentsExtension(second.pi);
    try {
      expect(customDesc).toBe(second.tools.get("agent").description);
    } finally {
      await second.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    }
  });

  it("custom mode without a file falls back to the full description with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tools = setup({ toolDescriptionMode: "custom" });
      const fallbackDescription: string = tools.get("agent").description;

      writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "full" }));
      const full = makePi();
      subagentsExtension(full.pi);
      try {
        expect(fallbackDescription).toBe(full.tools.get("agent").description);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("no agent-tool-description.md found"));
      } finally {
        await full.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
      }
    } finally {
      warn.mockRestore();
    }
  });
});
