import { writeFixtureAgent } from "./helpers/fixture-agent.js";
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
import { SUBAGENT_COMMUNICATION_CONTRACT } from "../src/prompts.js";

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
    writeFixtureAgent(tmpDir);
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

  it.each(["full", "compact", "custom"])("appends the shared communication contract in %s mode", (mode) => {
    const template = "fixture custom description";
    const tools = setup({ toolDescriptionMode: mode }, () => {
      if (mode === "custom") writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), template);
    });
    const description: string = tools.get("agent").description;
    expect(description.endsWith("\n\n" + SUBAGENT_COMMUNICATION_CONTRACT)).toBe(true);
    expect(description.split(SUBAGENT_COMMUNICATION_CONTRACT)).toHaveLength(2);
    if (mode === "custom") expect(description.startsWith(template)).toBe(true);
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
      mkdirSync(dir, { recursive: true });
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

  const policy = (mode: string, allow: string[]) => ({ mode, delegationPolicy: { version: 2, rules: allow.map((selector) => ({ sign: "+", selector })) } });
  it.each([
    { name: "kuafu allows alpha", data: policy("kuafu", ["alpha"]), active: true, present: ["alpha"], absent: ["beta"] },
    { name: "fuxi allows beta", data: policy("fuxi", ["beta"]), active: true, present: ["beta"], absent: ["alpha"] },
    { name: "no policy permits none", data: { mode: "fuxi" }, active: true, present: ["none"], absent: ["alpha", "beta"] },
    { name: "inactive agent tool sets no section", data: policy("kuafu", ["alpha"]), active: false, present: [], absent: [] },
  ])("sets the subagents prompt section for mode policy: $name", async ({ data, active, present, absent }) => {
    setup({ toolDescriptionMode: "full" }, () => {
      const dir = join(tmpDir, ".pi", "agents");
      mkdirSync(dir, { recursive: true });
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

  describe("mode prompt roster placement", () => {
    const rosterCtx = { sessionManager: { getEntries: () => [{ type: "custom", customType: "agent-mode", data: policy("kuafu", ["alpha", "beta"]) }] } };
    const bridge = () => ({
      renderAgentRoster(ctx: unknown, options: { sections: Record<string, string> }): string {
        const entry: unknown = Reflect.get(globalThis, Symbol.for("pi-subagents:manager"));
        if (typeof entry !== "object" || entry === null || !("renderAgentRoster" in entry) || typeof entry.renderAgentRoster !== "function") {
          throw new Error("renderAgentRoster bridge was not published");
        }
        const roster: unknown = entry.renderAgentRoster(ctx, options);
        if (typeof roster !== "string") throw new Error("renderAgentRoster returned a non-string roster");
        return roster;
      },
    });
    const run = (sections: Record<string, string> = {}) => ({ systemPrompt: "BASE", systemPromptOptions: { sections } });
    const rosterRows = (text: string) => text.split("\n").filter((line) => /^- (alpha|beta|gamma):/.test(line)).map((line) => line.split(":")[0]);
    function setupRoster(mode: string) {
      return setup({ toolDescriptionMode: mode }, () => {
        const dir = join(tmpDir, ".pi", "agents");
        mkdirSync(dir, { recursive: true });
        for (const name of ["alpha", "beta", "gamma"]) writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name} worker. Extra detail.\n---\nWork.\n`);
        if (mode === "custom") writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), "{{typeList}}\nCOMPACT\n{{compactTypeList}}");
      });
    }

    it.each(["full", "compact", "custom"])("moves the permitted roster into the mode prompt and restores the listed tool in %s mode", async (mode) => {
      const tools = setupRoster(mode);
      const listed: string = tools.get("agent").description;
      expect(rosterRows(listed)).toEqual(mode === "custom" ? ["- alpha", "- beta", "- gamma", "- alpha", "- beta", "- gamma"] : ["- alpha", "- beta", "- gamma"]);

      const rosterRun = run({ subagents: "stale hint" });
      const roster = bridge().renderAgentRoster(rosterCtx, rosterRun.systemPromptOptions);
      await currentHandlers.get("before_agent_start")(rosterRun, rosterCtx);
      expect(rosterRows(roster)).toEqual(["- alpha", "- beta"]);
      expect(roster.includes("Extra detail.")).toBe(mode !== "compact");
      expect(rosterRun.systemPromptOptions.sections.subagents).toBeUndefined();
      const rosterless: string = tools.get("agent").description;
      expect(rosterRows(rosterless)).toEqual([]);
      expect(rosterless.endsWith("\n\n" + SUBAGENT_COMMUNICATION_CONTRACT)).toBe(true);
      if (mode === "custom") expect(rosterless.startsWith("\nCOMPACT\n\n\n")).toBe(true);

      const plainRun = run();
      await currentHandlers.get("before_agent_start")(plainRun, rosterCtx);
      expect(plainRun.systemPromptOptions.sections.subagents).toContain("alpha, beta");
      expect(tools.get("agent").description).toBe(listed);
    });

    it("converges to the same prompt and tool when the subagents handler runs before the roster render", async () => {
      const tools = setupRoster("full");
      const modesFirst = run();
      bridge().renderAgentRoster(rosterCtx, modesFirst.systemPromptOptions);
      await currentHandlers.get("before_agent_start")(modesFirst, rosterCtx);
      const modesFirstDescription: string = tools.get("agent").description;
      await currentHandlers.get("before_agent_start")(run(), rosterCtx);

      const subagentsFirst = run();
      await currentHandlers.get("before_agent_start")(subagentsFirst, rosterCtx);
      bridge().renderAgentRoster(rosterCtx, subagentsFirst.systemPromptOptions);
      expect(subagentsFirst.systemPromptOptions.sections).toEqual(modesFirst.systemPromptOptions.sections);
      expect(tools.get("agent").description).toBe(modesFirstDescription);
    });

    it("renders an empty roster and keeps the listed tool while the agent tool is inactive", () => {
      const tools = setupRoster("full");
      const listed: string = tools.get("agent").description;
      currentActiveTools.length = 0;
      expect(bridge().renderAgentRoster(rosterCtx, run().systemPromptOptions)).toBe("");
      expect(tools.get("agent").description).toBe(listed);
    });
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
    expect(desc).toContain("- fixture:");
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
    expect(desc).toContain("fixture");
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
