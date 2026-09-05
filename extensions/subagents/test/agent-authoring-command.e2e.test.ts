import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseAgentMarkdown } from "../../lib/agent-frontmatter.js";
import { AgentManager } from "../src/agent-manager.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig } from "../src/agent-types.js";
import { loadCustomAgentsWithDiagnostics } from "../src/custom-agents.js";
import subagentsExtension from "../src/index.js";
import { ctx, hermeticDir, makePi } from "./helpers/boot-extension.js";

// Real registration, filesystem, shared parser and loader; only dialogs and the
// model that writes the requested file are scripted. No auth or network needed.
describe("/agents authoring callbacks (real SDK)", () => {
  it.each([
    ["all", BUILTIN_TOOL_NAMES, undefined],
    ["none", [], undefined],
    ["read-only (read, bash, grep, find, ls)", ["read", "bash", "grep", "find", "ls"], undefined],
    ["custom...", ["read"], ["search_docs", "lookup: #private"]],
  ])("saves and reloads a manual %s definition", async (tools, builtins, extensions) => {
    const sandbox = hermeticDir();
    const booted = makePi();
    try {
      subagentsExtension(booted.pi);
      const selections = ["Create new agent", "Project (.pi/agents/)", "Manual configuration", tools, "inherit (parent model)", "inherit"];
      const inputs = ["manual", "Review: #security", "read, search_docs, lookup: #private"];
      const notify = vi.fn();
      await booted.commands.get("agents").handler("", ctx({ ui: {
        select: async (_title: string, options: string[]) => {
          const choice = selections.shift();
          expect(options).toContain(choice);
          return choice;
        },
        input: async () => inputs.shift(), editor: async () => "Review changes.", notify,
      } }));
      const content = readFileSync(join(sandbox.dir, ".pi", "agents", "manual.md"), "utf8");
      expect(parseAgentMarkdown(content).invalidFields).toEqual([]);
      expect(loadCustomAgentsWithDiagnostics(sandbox.dir).diagnostics).toEqual([]);
      expect(getAgentConfig("manual")).toMatchObject({
        description: "Review: #security", builtinToolNames: builtins, extensionToolNames: extensions,
        model: undefined, thinking: undefined, systemPrompt: "Review changes.", source: "project",
      });
      expect(notify.mock.calls.at(-1)?.[1]).toBe("info");
    } finally {
      await booted.lifecycle.get("session_shutdown")?.();
      sandbox.restore();
    }
  });

  it("ejects an embedded default through the registered menu and reloads it", async () => {
    const sandbox = hermeticDir();
    const booted = makePi();
    try {
      subagentsExtension(booted.pi);
      const before = getAgentConfig("general-purpose");
      const picks = ["Agent types (3)", "Eject (export as .md)", "Project (.pi/agents/)"];
      let selected = false;
      await booted.commands.get("agents").handler("", ctx({ ui: {
        select: async (_title: string, options: string[]) => {
          const choice = picks.shift();
          if (choice) expect(options).toContain(choice);
          return choice;
        },
        custom: async () => { if (selected) return undefined; selected = true; return "general-purpose"; },
        notify: vi.fn(),
      } }));
      const content = readFileSync(join(sandbox.dir, ".pi", "agents", "general-purpose.md"), "utf8");
      expect(parseAgentMarkdown(content).invalidFields).toEqual([]);
      expect(loadCustomAgentsWithDiagnostics(sandbox.dir).diagnostics).toEqual([]);
      expect(getAgentConfig("general-purpose")).toMatchObject({
        description: before?.description, systemPrompt: before?.systemPrompt,
        builtinToolNames: before?.builtinToolNames ?? BUILTIN_TOOL_NAMES, source: "project",
      });
    } finally {
      await booted.lifecycle.get("session_shutdown")?.();
      sandbox.restore();
    }
  });

  it.each(["valid", "obsolete", "malformed"])("handles %s generated artifacts before announcing success", async (kind) => {
    const sandbox = hermeticDir();
    const booted = makePi();
    const target = join(sandbox.dir, ".pi", "agents", "generated.md");
    const generate = vi.spyOn(AgentManager.prototype, "spawnAndWait").mockImplementation(async (_pi, _ctx, _type, prompt) => {
      const example = /```(?:markdown|yaml)\n([\s\S]*?)\n```/.exec(prompt)?.[1];
      if (!example) throw new Error("Generation schema has no fenced example");
      let content = example;
      if (kind === "obsolete") content = "---\ntools: none\n---\nReview changes.";
      if (kind === "malformed") content = "---\nbuiltin_tools: [unterminated\n---\nReview changes.";
      writeFileSync(target, content);
      return { id: "generator", record: {
        id: "generator", type: "general-purpose", description: "Generate", status: "completed",
        toolUses: 1, startedAt: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
        lifetimeCost: 0, compactionCount: 0,
      } };
    });
    try {
      subagentsExtension(booted.pi);
      const picks = ["Create new agent", "Project (.pi/agents/)", "Generate with Claude (recommended)"];
      const inputs = ["Review code", "generated"];
      const notify = vi.fn();
      await booted.commands.get("agents").handler("", ctx({ ui: {
        select: async (_title: string, options: string[]) => {
          const choice = picks.shift();
          expect(options).toContain(choice);
          return choice;
        },
        input: async () => inputs.shift(), notify,
      } }));
      expect(generate).toHaveBeenCalledOnce();
      if (kind === "valid") {
        const parsed = parseAgentMarkdown(readFileSync(target, "utf8"));
        expect(parsed.invalidFields).toEqual([]);
        expect(parsed).toMatchObject({ builtinToolNames: BUILTIN_TOOL_NAMES, discoverSkills: true, preloadSkills: [] });
        expect(parsed.frontmatter).toMatchObject({
          builtin_tools: BUILTIN_TOOL_NAMES, extension_tools: [], allow_delegation_to: [], disallow_delegation_to: [],
          allow_nesting: false, discover_skills: true, preload_skills: [], max_turns: 0,
          persist_session: false, output_transcript: false,
        });
        expect(loadCustomAgentsWithDiagnostics(sandbox.dir).diagnostics).toEqual([]);
        expect(getAgentConfig("generated")).toMatchObject({ source: "project", maxTurns: 0, persistSession: false });
        expect(notify.mock.calls.map(call => call[1])).toEqual(["info", "info"]);
      } else {
        expect(notify.mock.calls.map(call => call[1])).toEqual(["info", "warning"]);
        expect(getAgentConfig("generated")).toBeUndefined();
      }
    } finally {
      generate.mockRestore();
      await booted.lifecycle.get("session_shutdown")?.();
      sandbox.restore();
    }
  });
});
