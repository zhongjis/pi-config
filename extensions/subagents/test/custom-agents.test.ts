import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCustomAgents, loadCustomAgentsWithDiagnostics } from "../src/custom-agents.js";

describe("loadCustomAgents", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-test-"));
    originalHome = process.env.HOME;
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tmpDir;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgentIn(projectDir: ".agents" | ".pi", name: string, content: string): string {
    const dir = join(tmpDir, projectDir, "agents");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${name}.md`);
    writeFileSync(filePath, content);
    return filePath;
  }

  function writeAgent(name: string, content: string): string {
    return writeAgentIn(".pi", name, content);
  }

  function writeWorkspaceAgent(name: string, content: string): string {
    return writeAgentIn(".agents", name, content);
  }

  it("returns empty map when custom agent dirs do not exist", () => {
    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(0);
  });

  it("loads a workspace project agent from .agents/agents", () => {
    writeWorkspaceAgent("reviewer", `---
description: Workspace Reviewer
---

Workspace prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get("reviewer")?.description).toBe("Workspace Reviewer");
    expect(result.get("reviewer")?.systemPrompt).toBe("Workspace prompt.");
    expect(result.get("reviewer")?.source).toBe("project");
  });

  it(".pi/agents overrides .agents/agents on a name clash", () => {
    writeWorkspaceAgent("dupe", `---
description: Workspace Project
---

Workspace prompt.`);
    writeAgent("dupe", `---
description: Pi Project
---

Pi prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get("dupe")?.description).toBe("Pi Project");
    expect(result.get("dupe")?.systemPrompt).toBe("Pi prompt.");
  });

  it("workspace project agents override global agents", () => {
    const globalAgentDir = join(tmpDir, "global-agent-dir");
    process.env.PI_CODING_AGENT_DIR = globalAgentDir;
    const globalAgents = join(globalAgentDir, "agents");
    mkdirSync(globalAgents, { recursive: true });
    writeFileSync(join(globalAgents, "dupe.md"), `---
description: Global
---

Global prompt.`);
    writeWorkspaceAgent("dupe", `---
description: Workspace Project
---

Workspace prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get("dupe")?.description).toBe("Workspace Project");
    expect(result.get("dupe")?.systemPrompt).toBe("Workspace prompt.");
  });

  it("loads a basic agent with all frontmatter fields", () => {
    writeAgent("auditor", `---
description: Security Auditor
extensions: +@all, -@builtin
tools: +read, +grep, +find
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
persist_session: true
output_transcript: false
session_dir: .seams/pi-sessions/seam-plan-reviewer
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
    expect(agent.extensionRules).toEqual([{ sign: "+", selector: "@all" }, { sign: "-", selector: "@builtin" }]);
    expect(agent.toolRules).toEqual([
      { sign: "+", selector: "read" },
      { sign: "+", selector: "grep" },
      { sign: "+", selector: "find" },
    ]);
    expect(agent.model).toBe("anthropic/claude-opus-4-6");
    expect(agent.thinking).toBe("high");
    expect(agent.maxTurns).toBe(30);
    expect(agent.persistSession).toBe(true);
    expect(agent.outputTranscript).toBe(false);
    expect(agent.sessionDir).toBe(".seams/pi-sessions/seam-plan-reviewer");
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
    expect(agent.toolRules).toEqual([]); // no tools
    expect(agent.extensionRules).toEqual([]); // no extensions load
    expect(agent.discoverSkills).toBe(true); // catalog on by default
    expect(agent.preloadSkills).toEqual([]); // nothing preloaded by default
    expect(agent.model).toBeUndefined();
    expect(agent.thinking).toBeUndefined();
    expect(agent.maxTurns).toBeUndefined();
    expect(agent.persistSession).toBeUndefined();
    expect(agent.outputTranscript).toBeUndefined();
    expect(agent.sessionDir).toBeUndefined();
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
    expect(agent.toolRules).toEqual([]);
    expect(agent.systemPrompt).toBe("Just a system prompt, no frontmatter.");
  });

  it("maps extensions: rules from a YAML list", () => {
    writeAgent("partial", `---
extensions:
  - +web-search
  - +mcp-server
---

Partial access.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("partial")!.extensionRules).toEqual([
      { sign: "+", selector: "web-search" },
      { sign: "+", selector: "mcp-server" },
    ]);
  });

  it("parses delegation and nesting fields", () => {
    writeAgent("delegator", `---
allow_delegation_to: Explore, Plan
disallow_delegation_to: general-purpose
allow_nesting: true
---

Delegates.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("delegator")!;
    expect(agent.allowDelegationTo).toEqual(["Explore", "Plan"]);
    expect(agent.disallowDelegationTo).toEqual(["general-purpose"]);
    expect(agent.allowNesting).toBe(true);
  });

  it("passes through thinking level as-is (no validation)", () => {
    writeAgent("anythink", `---
thinking: turbo
---

Any thinking.`);

    const result = loadCustomAgents(tmpDir);
    // Pi validates at session creation — the loader just passes the raw string through.
    expect(result.get("anythink")!.thinking).toBe("turbo");
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

  it("handles prompt_mode: system_instructions", () => {
    writeAgent("sysinstr", `---
prompt_mode: system_instructions
---

Instructions.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("sysinstr")!.promptMode).toBe("system_instructions");
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
tools: +read
---
`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("nobody")!.systemPrompt).toBe("");
  });

  it("handles enabled: false frontmatter", () => {
    writeAgent("disabled", `---
enabled: false
---
`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("disabled")!.enabled).toBe(false);
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

  it("skips an agent with an invalid frontmatter field and reports a diagnostic", () => {
    const file = writeAgent("unsigned", `---
tools: read
---

Unsigned rule.`);

    const result = loadCustomAgentsWithDiagnostics(tmpDir);
    expect(result.agents.has("unsigned")).toBe(false);
    expect(result.diagnostics).toMatchObject([
      {
        file,
        agentName: "unsigned",
        field: "tools",
        severity: "error",
      },
    ]);
  });

  it("reports every tools: error exactly once", () => {
    writeAgent("two-unsigned", `---
tools: read, grep
---

Two unsigned rules.`);

    const result = loadCustomAgentsWithDiagnostics(tmpDir);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      'unsigned entry "read": prefix + to grant or - to remove, e.g. "+read"',
      'unsigned entry "grep": prefix + to grant or - to remove, e.g. "+grep"',
    ]);
  });

  it("reports a rule warning and keeps the definition", () => {
    const file = writeAgent("leading-minus", `---
tools: -bash, +read
---

Leading minus.`);

    const result = loadCustomAgentsWithDiagnostics(tmpDir);
    expect({ loaded: result.agents.has("leading-minus"), diagnostics: result.diagnostics }).toEqual({
      loaded: true,
      diagnostics: [{
        file,
        agentName: "leading-minus",
        field: "tools",
        severity: "warning",
        message: 'leading "-bash" removes nothing from the empty start.',
      }],
    });
  });

  it("reports an extensions: error without skipping the definition (transitional)", () => {
    writeAgent("boolean-extensions", `---
extensions: false
---

Boolean extensions.`);

    const result = loadCustomAgentsWithDiagnostics(tmpDir);
    expect({ loaded: result.agents.has("boolean-extensions"), diagnostics: result.diagnostics.map((d) => [d.field, d.severity]) })
      .toEqual({ loaded: true, diagnostics: [["extensions", "error"]] });
  });

  // ─── skill fields (discover_skills / preload_skills) ────────────────────

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
});
