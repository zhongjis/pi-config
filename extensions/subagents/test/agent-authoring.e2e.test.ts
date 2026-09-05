import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAgentMarkdown } from "../../lib/agent-frontmatter.js";
import { buildNewAgentFile, serializeAgentFile } from "../src/agent-file-toggle.js";
import { BUILTIN_TOOL_NAMES } from "../src/agent-types.js";
import { loadCustomAgentsWithDiagnostics } from "../src/custom-agents.js";
import type { AgentConfig } from "../src/types.js";

describe("ejected definitions through the real SDK parser and loader", () => {
  it.each([false, true])("preserves current fields including explicit %s and zero", (flag) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-eject-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    const cfg: AgentConfig = {
      name: "reviewer", description: 'Review: #security "quoted"\nsecond line',
      displayName: 'Reviewer: #1 "金童"', builtinToolNames: [], extensionToolNames: [],
      extensions: flag, excludeExtensions: ["notify: #quiet"],
      allowDelegationTo: ["review: #one"], disallowDelegationTo: ["writer"], allowNesting: flag,
      discoverSkills: flag, preloadSkills: [], model: "provider/model:high #quoted",
      thinking: "low", maxTurns: 0, persistSession: flag, outputTranscript: flag,
      sessionDir: 'sessions: #private/"quoted"', promptMode: "system_instructions",
      inheritContext: flag, runInBackground: flag, isolated: flag, enabled: flag,
      skills: true, systemPrompt: "Review changes.\n\nReport findings.",
    };
    try {
      process.env.PI_CODING_AGENT_DIR = join(dir, "personal");
      const target = join(dir, ".pi", "agents", "reviewer.md");
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(target, serializeAgentFile(cfg));
      const parsed = parseAgentMarkdown(readFileSync(target, "utf8"));
      expect(parsed.invalidFields).toEqual([]);
      const loaded = loadCustomAgentsWithDiagnostics(dir);
      expect(loaded.diagnostics).toEqual([]);
      expect(loaded.agents.get("reviewer")).toEqual({ ...cfg, source: "project" });
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits explicit installed builtins for an unrestricted default", () => {
    const parsed = parseAgentMarkdown(serializeAgentFile({
      name: "default", description: "Default", extensions: true, skills: true,
      promptMode: "replace", systemPrompt: "Work.",
    }));
    expect(parsed.invalidFields).toEqual([]);
    expect(parsed.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(parsed.frontmatter.builtin_tools).toEqual(BUILTIN_TOOL_NAMES);
  });

  it("preserves empty current selections in frontmatter without emitting historical config", () => {
    const parsed = parseAgentMarkdown(serializeAgentFile({
      name: "empty", description: "", displayName: "", model: "", sessionDir: "",
      builtinToolNames: [], extensionToolNames: [], extensions: [], excludeExtensions: [],
      allowDelegationTo: [], disallowDelegationTo: [], discoverSkills: false, preloadSkills: [],
      skills: false, disallowedTools: ["write"], allowedSubagents: "all", memory: "user", color: "red",
      promptMode: "append", systemPrompt: "",
    }));
    expect(parsed.invalidFields).toEqual([]);
    expect(parsed.frontmatter).toEqual({
      description: "", display_name: "", model: "", session_dir: "",
      builtin_tools: [], extension_tools: [], extensions: [], exclude_extensions: [],
      allow_delegation_to: [], disallow_delegation_to: [], discover_skills: false, preload_skills: [],
      prompt_mode: "append",
    });
  });
});

describe("manual definition discovery", () => {
  it.each([
    ["all", ["read", "bash", "edit", "write", "grep", "find", "ls"], undefined],
    ["none", [], undefined],
    ["read, grep", ["read", "grep"], undefined],
    ["read, search_docs, custom: #quoted", ["read"], ["search_docs", "custom: #quoted"]],
  ])("loads the saved %s selection through the strict schema", (tools, builtins, extensions) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-authoring-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = join(dir, "personal");
      const target = join(dir, ".pi", "agents");
      mkdirSync(target, { recursive: true });
      const content = buildNewAgentFile({ tools, description: "Review: #security", systemPrompt: "Review changes." });
      writeFileSync(join(target, "reviewer.md"), content);
      expect(parseAgentMarkdown(content).invalidFields).toEqual([]);
      const loaded = loadCustomAgentsWithDiagnostics(dir);
      expect(loaded.diagnostics).toEqual([]);
      expect(loaded.agents.get("reviewer")).toMatchObject({
        description: "Review: #security", builtinToolNames: builtins, extensionToolNames: extensions,
      });
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
