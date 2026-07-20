import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_TOOL_NAMES } from "../src/agent-types.js";
import { loadCustomAgents, loadCustomAgentsWithDiagnostics } from "../src/custom-agents.js";

describe("loadCustomAgents", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgent(name: string, content: string): string {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${name}.md`);
    writeFileSync(filePath, content);
    return filePath;
  }

  it("returns empty map when .pi/agents/ does not exist", () => {
    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(0);
  });

  it("loads a basic agent with all frontmatter fields", () => {
    writeAgent("auditor", `---
description: Security Auditor
builtin_tools: read, grep, find
model: anthropic/claude-opus-4-6:high
max_turns: 30
prompt_mode: replace
inherit_context: true
run_in_background: true
isolated: true
---

You are a security auditor.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);

    const agent = result.get("auditor")!;
    expect(agent.name).toBe("auditor");
    expect(agent.description).toBe("Security Auditor");
    expect(agent.builtinToolNames).toEqual(["read", "grep", "find"]);
    expect(agent.extensionToolNames).toBeUndefined();
    expect(agent.model).toBe("anthropic/claude-opus-4-6:high");
    expect(agent.maxTurns).toBe(30);
    expect(agent.promptMode).toBe("replace");
    expect(agent.inheritContext).toBe(true);
    expect(agent.runInBackground).toBe(true);
    expect(agent.isolated).toBe(true);
    expect(agent.systemPrompt).toBe("You are a security auditor.");
  });

  it("uses sensible defaults when frontmatter is empty", () => {
    writeAgent("minimal", `---
---

Just a prompt.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("minimal")!;

    expect(agent.name).toBe("minimal");
    expect(agent.description).toBe("minimal"); // defaults to filename
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES); // all tools
    expect(agent.extensions).toBe(true); // inherit all
    expect(agent.discoverSkills).toBe(true); // catalog on by default
    expect(agent.preloadSkills).toEqual([]); // nothing preloaded by default
    expect(agent.model).toBeUndefined();
    expect(agent.thinking).toBeUndefined();
    expect(agent.maxTurns).toBeUndefined();
    expect(agent.promptMode).toBe("replace");
    expect(agent.inheritContext).toBeUndefined();
    expect(agent.runInBackground).toBeUndefined();
    expect(agent.isolated).toBeUndefined();
    expect(agent.systemPrompt).toBe("Just a prompt.");
  });

  it("uses sensible defaults when no frontmatter at all", () => {
    writeAgent("bare", "Just a system prompt, no frontmatter.");

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("bare")!;

    expect(agent.name).toBe("bare");
    expect(agent.description).toBe("bare");
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(agent.systemPrompt).toBe("Just a system prompt, no frontmatter.");
  });

  it("handles builtin_tools: none → empty array", () => {
    writeAgent("notool", `---
builtin_tools: none
---

No tools.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("notool")!.builtinToolNames).toEqual([]);
  });

  it("handles extensions: false → no extensions", () => {
    writeAgent("noext", `---
extensions: false
---

No extensions.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("noext")!;
    expect(agent.extensions).toBe(false);
  });

  it("preserves extensions CSV source scope", () => {
    writeAgent("partial", `---
extensions: web-search, mcp-server
---

Partial access.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("partial")!;
    expect(agent.extensions).toEqual(["web-search", "mcp-server"]);
  });

  it("keeps only canonical names from builtin_tools", () => {
    writeAgent("custom-tools", `---
builtin_tools: read, my_custom_tool, grep
---

Custom tools.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("custom-tools")!.builtinToolNames).toEqual(["read", "grep"]);
  });

  it("normalizes invalid thinking level to undefined", () => {
    writeAgent("anythink", `---
thinking: turbo
---

Any thinking.`);

    const result = loadCustomAgents(tmpDir);
    // Local code uses normalizeThinkingLevel — invalid values become undefined
    expect(result.get("anythink")!.thinking).toBeUndefined();
  });

  it("accepts max_turns: 0 as unlimited", () => {
    writeAgent("unlimited", `---
max_turns: 0
---

Unlimited turns.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("unlimited")!.maxTurns).toBe(0);
  });

  it("rejects negative max_turns", () => {
    writeAgent("negturns", `---
max_turns: -5
---

Negative turns.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("negturns")!.maxTurns).toBeUndefined();
  });

  it("handles prompt_mode: append", () => {
    writeAgent("appender", `---
prompt_mode: append
---

Extra instructions.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("appender")!.promptMode).toBe("append");
  });

  it("defaults unknown prompt_mode to replace", () => {
    writeAgent("badmode", `---
prompt_mode: merge
---

Unknown mode.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("badmode")!.promptMode).toBe("replace");
  });

  it("loads multiple agents", () => {
    writeAgent("agent1", `---
description: First
---

First agent.`);
    writeAgent("agent2", `---
description: Second
---

Second agent.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(2);
    expect(result.has("agent1")).toBe(true);
    expect(result.has("agent2")).toBe(true);
  });

  it("skips non-.md files", () => {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "not an agent");
    writeFileSync(join(dir, "real.md"), `---
description: Real Agent
---

Real.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has("real")).toBe(true);
  });

  it("ignores AGENTS.md context docs", () => {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "# Agent authoring docs");
    writeFileSync(join(dir, "real.md"), `---
description: Real Agent
---

Real.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has("AGENTS")).toBe(false);
    expect(result.has("real")).toBe(true);
  });

  it("allows agents with names matching defaults (overrides them)", () => {
    writeAgent("Explore", `---
description: Custom Explore
---

Custom explore agent.`);
    writeAgent("custom", `---
description: Custom Agent
---

Should be loaded.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.has("Explore")).toBe(true);
    expect(result.get("Explore")!.description).toBe("Custom Explore");
    expect(result.has("custom")).toBe(true);
  });

  it("handles empty body with frontmatter", () => {
    writeAgent("nobody", `---
description: No body
builtin_tools: read
---
`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("nobody")!.systemPrompt).toBe("");
  });

  it("supports inherit_extensions as alternative to extensions", () => {
    writeAgent("altkey", `---
inherit_extensions: false
---

Alt keys.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("altkey")!;
    expect(agent.extensions).toBe(false);
  });

  it("extensions: none → false", () => {
    writeAgent("extnone", `---
extensions: none
---

None.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("extnone")!;
    expect(agent.extensions).toBe(false);
  });

  it("extensions: true → true (inherit all)", () => {
    writeAgent("exttrue", `---
extensions: true
---

All.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("exttrue")!;
    expect(agent.extensions).toBe(true);
  });

  it("handles enabled: false frontmatter", () => {
    writeAgent("disabled", `---
enabled: false
---
`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("disabled")!;
    expect(agent.enabled).toBe(false);
  });

  it("parses display_name frontmatter", () => {
    writeAgent("myagent", `---
description: My Agent
display_name: MyAgent
---

Agent prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("myagent")!.displayName).toBe("MyAgent");
  });

  it("rejects disallowed_tools and skips the invalid agent", () => {
    const file = writeAgent("restricted", `---
description: Restricted Agent
disallowed_tools: bash, write
---

No bash or write.`);

    const result = loadCustomAgentsWithDiagnostics(tmpDir);
    expect(result.agents.has("restricted")).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        file,
        agentName: "restricted",
        field: "disallowed_tools",
        severity: "error",
        message: "disallowed_tools is invalid/obsolete; use builtin_tools and extension_tools explicit allowlists instead.",
      },
    ]);
  });

  it("disallowed_tools defaults to undefined when omitted", () => {
    writeAgent("unrestricted", `---
description: Unrestricted
---

All tools.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("unrestricted")!.disallowedTools).toBeUndefined();
  });

  it("rejects disallow_tools and skips the invalid agent", () => {
    const file = writeAgent("restricted-alias", `---
description: Restricted Agent
disallow_tools: bash, write
---

No bash or write.`);

    const result = loadCustomAgentsWithDiagnostics(tmpDir);
    expect(result.agents.has("restricted-alias")).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        file,
        agentName: "restricted-alias",
        field: "disallow_tools",
        severity: "error",
        message: "disallow_tools is invalid/obsolete; use builtin_tools and extension_tools explicit allowlists instead.",
      },
    ]);
  });

  it("rejects legacy tools and skips the invalid agent", () => {
    const file = writeAgent("legacy", `---
tools: read, custom_extension_tool, grep
---

Legacy tools.`);

    const result = loadCustomAgentsWithDiagnostics(tmpDir);
    expect(result.agents.has("legacy")).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        file,
        agentName: "legacy",
        field: "tools",
        severity: "error",
        message: "tools is invalid/obsolete; use builtin_tools for built-in tools and extension_tools for extension/custom tools instead.",
      },
    ]);
  });

  it("rejects legacy tools even when builtin_tools is present", () => {
    const file = writeAgent("both", `---
builtin_tools: bash
tools: read, grep
---

Both fields.`);

    const result = loadCustomAgentsWithDiagnostics(tmpDir);
    expect(result.agents.has("both")).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        file,
        agentName: "both",
        field: "tools",
        severity: "error",
        message: "tools is invalid/obsolete; use builtin_tools for built-in tools and extension_tools for extension/custom tools instead.",
      },
    ]);
  });

  it("parses extension_tools separately from extensions", () => {
    writeAgent("extension-picker", `---
extensions: web-search, mcp-server
extension_tools: search_web, list_servers
---

Extension tools.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("extension-picker")!;
    expect(agent.extensions).toEqual(["web-search", "mcp-server"]);
    expect(agent.extensionToolNames).toEqual(["search_web", "list_servers"]);
  });

  it("preserves extension_tools suffix wildcard entries", () => {
    writeAgent("extension-wildcard", `---
extension_tools: codegraph_*
---

Extension wildcard.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("extension-wildcard")!.extensionToolNames).toEqual(["codegraph_*"]);
  });

  it("distinguishes omitted extension_tools from none", () => {
    writeAgent("extension-default", `---
extensions: web-search
---

All extension tools.`);
    writeAgent("extension-none", `---
extensions: web-search
extension_tools: none
---

No extension tools.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("extension-default")!.extensionToolNames).toBeUndefined();
    expect(result.get("extension-none")!.extensionToolNames).toEqual([]);
  });


  it("honors PI_CODING_AGENT_DIR for global custom agent discovery", () => {
    const altAgentDir = mkdtempSync(join(tmpdir(), "pi-alt-agent-"));
    const originalEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = altAgentDir;
    try {
      const globalAgentsDir = join(altAgentDir, "agents");
      mkdirSync(globalAgentsDir, { recursive: true });
      writeFileSync(
        join(globalAgentsDir, "via-env.md"),
        "---\ndescription: Discovered via env var\n---\n\nTest body.",
      );
      writeFileSync(join(globalAgentsDir, "AGENTS.md"), "# Global agent authoring docs");

      const result = loadCustomAgents(tmpDir);

      // Agent is found at $PI_CODING_AGENT_DIR/agents, not at $HOME/.pi/agent/agents
      expect(result.has("via-env")).toBe(true);
      expect(result.get("via-env")!.description).toBe("Discovered via env var");
      expect(result.has("AGENTS")).toBe(false);
    } finally {
      if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalEnv;
      rmSync(altAgentDir, { recursive: true, force: true });
    }
  });

  it("S1: omitted skill fields default to catalog on, no preload", () => {
    writeAgent("s1", `---
description: Defaults
---

Body.`);

    const agent = loadCustomAgents(tmpDir).get("s1")!;
    expect(agent.discoverSkills).toBe(true);
    expect(agent.preloadSkills).toEqual([]);
  });

  it("S2: discover_skills false with preload_skills list", () => {
    writeAgent("s2", `---
discover_skills: false
preload_skills: a, b
---

Body.`);

    const agent = loadCustomAgents(tmpDir).get("s2")!;
    expect(agent.discoverSkills).toBe(false);
    expect(agent.preloadSkills).toEqual(["a", "b"]);
  });

  it("S3: discover_skills true with preload_skills (catalog on AND preload)", () => {
    writeAgent("s3", `---
discover_skills: true
preload_skills: a
---

Body.`);

    const agent = loadCustomAgents(tmpDir).get("s3")!;
    expect(agent.discoverSkills).toBe(true);
    expect(agent.preloadSkills).toEqual(["a"]);
  });

  it("S4: discover_skills false with no preload_skills", () => {
    writeAgent("s4", `---
discover_skills: false
---

Body.`);

    const agent = loadCustomAgents(tmpDir).get("s4")!;
    expect(agent.discoverSkills).toBe(false);
    expect(agent.preloadSkills).toEqual([]);
  });

  it("S5: legacy skills field is invalid and skips the agent", () => {
    const file = writeAgent("s5", `---
skills: complexity
---

Body.`);

    const result = loadCustomAgentsWithDiagnostics(tmpDir);
    expect(result.agents.has("s5")).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        file,
        agentName: "s5",
        field: "skills",
        severity: "error",
        message: "skills/inherit_skills is invalid/obsolete; use discover_skills (catalog on/off) and preload_skills (eager-inject names) instead.",
      },
    ]);
  });

  it("S5b: legacy inherit_skills field is invalid and skips the agent", () => {
    const file = writeAgent("s5b", `---
inherit_skills: false
---

Body.`);

    const result = loadCustomAgentsWithDiagnostics(tmpDir);
    expect(result.agents.has("s5b")).toBe(false);
    expect(result.diagnostics).toEqual([
      {
        file,
        agentName: "s5b",
        field: "inherit_skills",
        severity: "error",
        message: "skills/inherit_skills is invalid/obsolete; use discover_skills (catalog on/off) and preload_skills (eager-inject names) instead.",
      },
    ]);
  });
});
