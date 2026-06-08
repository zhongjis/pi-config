/**
 * `/agents` interactive command — browse running agents, view conversations,
 * create/edit/eject/disable custom agents, and configure settings.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isTui } from "../../../lib/mode.js";
import { type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildEjectedAgentMarkdown, buildGenerateAgentPrompt, buildManualAgentMarkdown } from "../agent-definition-authoring.js";
import { getDefaultMaxTurns, getGraceTurns, setDefaultMaxTurns, setGraceTurns } from "../agent-runner.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAllTypes } from "../agent-types.js";
import { SUBAGENT_DECIMAL_RADIX, SUBAGENT_MAX_GENERATION_TURNS } from "../constants.js";
import { formatAgentDefinitionDiagnostics, getModelLabelFromConfig } from "../lifecycle/supervision.js";
import type { SubagentRuntimeContext } from "../lifecycle/supervision.js";
import { type ModelRegistry, parseModelChain, resolveModel } from "../model-resolver.js";
import { type SubagentsSettings, saveAndEmitChanged } from "../settings.js";
import type { AgentConfig, AgentRecord, JoinMode } from "../types.js";
import { formatDuration, getDisplayName } from "../ui/agent-widget.js";

export function registerAgentsCommand(ctx: SubagentRuntimeContext): void {
  const {
    pi,
    manager,
    agentActivity,
    reloadCustomAgents,
    getLatestDiagnostics,
    getDefaultJoinMode,
    setDefaultJoinMode,
  } = ctx;

  const projectAgentsDir = () => join(process.cwd(), ".pi", "agents");
  const personalAgentsDir = () => join(getAgentDir(), "agents");

  /** Find the file path of a custom agent by name (project first, then global). */
  function findAgentFile(name: string): { path: string; location: "project" | "personal" } | undefined {
    const projectPath = join(projectAgentsDir(), `${name}.md`);
    if (existsSync(projectPath)) return { path: projectPath, location: "project" };
    const personalPath = join(personalAgentsDir(), `${name}.md`);
    if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
    return undefined;
  }

  function getModelLabel(type: string, registry?: ModelRegistry): string {
    const cfg = getAgentConfig(type);
    if (!cfg?.model) return "inherit";
    const candidates = parseModelChain(cfg.model);
    if (candidates.length === 0) return "inherit";
    if (registry) {
      const resolved = resolveModel(candidates[0].model, registry);
      if (typeof resolved === "string") return "inherit";
    }
    return getModelLabelFromConfig(candidates[0].model);
  }

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    reloadCustomAgents();
    const allNames = getAllTypes();

    // Build select options
    const options: string[] = [];

    // Running agents entry (only if there are active agents)
    const agents = manager.listAgents();
    if (agents.length > 0) {
      const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
      const done = agents.filter(a => a.status === "completed" || a.status === "steered").length;
      options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
    }

    // Agent types list
    if (allNames.length > 0) {
      options.push(`Agent types (${allNames.length})`);
    }

    // Actions
    if (getLatestDiagnostics().length > 0) {
      options.push(`Agent definition issues (${getLatestDiagnostics().length})`);
    }
    options.push("Create new agent");
    options.push("Settings");

    const noAgentsMsg = allNames.length === 0 && agents.length === 0
      ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
        "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
        "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
      : "";

    if (noAgentsMsg) {
      ctx.ui.notify(noAgentsMsg, "info");
    }

    const choice = await ctx.ui.select("Agents", options);
    if (!choice) return;

    if (choice.startsWith("Running agents (")) {
      await showRunningAgents(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Agent types (")) {
      await showAllAgentsList(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Agent definition issues (")) {
      ctx.ui.notify(formatAgentDefinitionDiagnostics(getLatestDiagnostics()), "warning");
    } else if (choice === "Create new agent") {
      await showCreateWizard(ctx);
    } else if (choice === "Settings") {
      await showSettings(ctx);
      await showAgentsMenu(ctx);
    }
  }

  async function showAllAgentsList(ctx: ExtensionCommandContext) {
    const allNames = getAllTypes();
    if (allNames.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    // Source indicators: custom agents get • (project) or ◦ (global).
    // Disabled agents get ✕ prefix
    const sourceIndicator = (cfg: AgentConfig | undefined) => {
      const disabled = cfg?.enabled === false;
      if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
      if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
      if (disabled) return "✕  ";
      return "   ";
    };

    const entries = allNames.map(name => {
      const cfg = getAgentConfig(name);
      const disabled = cfg?.enabled === false;
      const model = getModelLabel(name, ctx.modelRegistry);
      const indicator = sourceIndicator(cfg);
      const prefix = `${indicator}${name} · ${model}`;
      const desc = disabled ? "(disabled)" : (cfg?.description ?? name);
      return { name, prefix, desc };
    });
    const maxPrefix = Math.max(...entries.map(e => e.prefix.length));

    const hasCustom = allNames.some(n => { const c = getAgentConfig(n); return c && !c.isDefault && c.enabled !== false; });
    const hasDisabled = allNames.some(n => getAgentConfig(n)?.enabled === false);
    const legendParts: string[] = [];
    if (hasCustom) legendParts.push("• = project  ◦ = global");
    if (hasDisabled) legendParts.push("✕ = disabled");
    const legend = legendParts.length ? "\n" + legendParts.join("  ") : "";

    const options = entries.map(({ prefix, desc }) =>
      `${prefix.padEnd(maxPrefix)} — ${desc}`,
    );
    if (legend) options.push(legend);

    const choice = await ctx.ui.select("Agent types", options);
    if (!choice) return;

    const agentName = choice.split(" · ")[0].replace(/^[•◦✕\s]+/, "").trim();
    if (getAgentConfig(agentName)) {
      await showAgentDetail(ctx, agentName);
      await showAllAgentsList(ctx);
    }
  }

  async function showRunningAgents(ctx: ExtensionCommandContext) {
    const agents = manager.listAgents();
    if (agents.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    const options = agents.map(a => {
      const dn = getDisplayName(a.type);
      const dur = formatDuration(a.startedAt, a.completedAt);
      return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
    });

    const choice = await ctx.ui.select("Running agents", options);
    if (!choice) return;

    // Find the selected agent by matching the option index
    const idx = options.indexOf(choice);
    if (idx < 0) return;
    const record = agents[idx];

    await viewAgentConversation(ctx, record);
    // Back-navigation: re-show the list
    await showRunningAgents(ctx);
  }

  async function viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord) {
    if (!record.session) {
      ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info");
      return;
    }

    if (!isTui(ctx)) {
      ctx.ui.notify("Conversation viewer requires interactive (TUI) mode.", "info");
      return;
    }

    const { ConversationViewer } = await import("../ui/conversation-viewer.js");
    const session = record.session;
    const activity = agentActivity.get(record.id);

    await ctx.ui.custom<undefined>(
      (tui, theme, _keybindings, done) => {
        return new ConversationViewer(tui, session, record, activity, theme, done);
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%" },
      },
    );
  }

  async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    if (!cfg) {
      ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
      return;
    }

    const file = findAgentFile(name);
    const isDefault = cfg.isDefault === true;
    const disabled = cfg.enabled === false;

    let menuOptions: string[];
    if (disabled && file) {
      menuOptions = isDefault
        ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
        : ["Enable", "Edit", "Delete", "Back"];
    } else if (isDefault && !file) {
      menuOptions = ["Eject (export as .md)", "Disable", "Back"];
    } else if (isDefault && file) {
      menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
    } else {
      menuOptions = ["Edit", "Disable", "Delete", "Back"];
    }

    const choice = await ctx.ui.select(name, menuOptions);
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) {
      const content = readFileSync(file.path, "utf-8");
      const edited = await ctx.ui.editor(`Edit ${name}`, content);
      if (edited !== undefined && edited !== content) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file.path, edited, "utf-8");
        reloadCustomAgents();
        ctx.ui.notify(`Updated ${file.path}`, "info");
      }
    } else if (choice === "Delete") {
      if (file) {
        const confirmed = await ctx.ui.confirm("Delete agent", `Delete ${name} from ${file.location} (${file.path})?`);
        if (confirmed) {
          unlinkSync(file.path);
          reloadCustomAgents();
          ctx.ui.notify(`Deleted ${file.path}`, "info");
        }
      }
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    } else if (choice === "Reset to default" && file) {
      const confirmed = await ctx.ui.confirm("Reset to default", `Delete override ${file.path} and restore embedded default?`);
      if (confirmed) {
        unlinkSync(file.path);
        reloadCustomAgents();
        ctx.ui.notify(`Restored default ${name}`, "info");
      }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    }
  }


  /** Disable an agent by setting enabled: false in its .md file. */
  async function disableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (file) {
      const content = readFileSync(file.path, "utf-8");
      if (content.includes("enabled: false")) {
        ctx.ui.notify(`${name} is already disabled.`, "info");
        return;
      }
      const updated = content.replace(/^---\n/, "---\nenabled: false\n");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
      return;
    }

    // No file (built-in default) — create a stub
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    const content = buildEjectedAgentMarkdown(cfg);

    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  /** Enable a disabled agent by removing enabled: false from its frontmatter. */
  async function enableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (!file) {
      ctx.ui.notify(`Cannot enable ${name}: no agent file found.`, "warning");
      return;
    }

    const content = readFileSync(file.path, "utf-8");
    const updated = content.replace(/^(---\n)enabled: false\n/, "$1");
    const { writeFileSync } = await import("node:fs");

    // If the file was just a stub (only "enabled: false"), delete it entirely
    if (updated.trim() === "---\n---" || updated.trim() === "---\n\n---") {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
    } else {
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
    }
  }

  async function showCreateWizard(ctx: ExtensionCommandContext) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();

    const method = await ctx.ui.select("Creation method", [
      "Generate with Claude (recommended)",
      "Manual configuration",
    ]);
    if (!method) return;

    if (method.startsWith("Generate")) {
      await showGenerateWizard(ctx, targetDir);
    } else {
      await showManualWizard(ctx, targetDir);
    }
  }

  async function showGenerateWizard(ctx: ExtensionCommandContext, targetDir: string) {
    const description = await ctx.ui.input("Describe what this agent should do");
    if (!description) return;

    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    ctx.ui.notify("Generating agent definition...", "info");

    const generatePrompt = buildGenerateAgentPrompt(description, targetPath);

    const record = await manager.spawnAndWait(pi, ctx, "general-purpose", generatePrompt, {
      description: `Generate ${name} agent`,
      maxTurns: SUBAGENT_MAX_GENERATION_TURNS,
    });

    if (record.status === "error") {
      ctx.ui.notify(`Generation failed: ${record.error}`, "warning");
      return;
    }

    reloadCustomAgents();

    if (existsSync(targetPath)) {
      ctx.ui.notify(`Created ${targetPath}`, "info");
    } else {
      ctx.ui.notify("Agent generation completed but file was not created. Check the agent output.", "warning");
    }
  }

  async function showManualWizard(ctx: ExtensionCommandContext, targetDir: string) {
    // 1. Name
    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    // 2. Description
    const description = await ctx.ui.input("Description (one line)");
    if (!description) return;

    // 3. Built-in tools
    const builtinToolChoice = await ctx.ui.select("builtin_tools (built-in tools)", ["all", "none", "read-only (read, bash; use rg/fd)", "custom..."]);
    if (!builtinToolChoice) return;

    let builtinTools: string;
    if (builtinToolChoice === "all") {
      builtinTools = BUILTIN_TOOL_NAMES.join(", ");
    } else if (builtinToolChoice === "none") {
      builtinTools = "none";
    } else if (builtinToolChoice.startsWith("read-only")) {
      builtinTools = "read, bash";
    } else {
      const customTools = await ctx.ui.input("builtin_tools (comma-separated built-ins)", BUILTIN_TOOL_NAMES.join(", "));
      if (!customTools) return;
      builtinTools = customTools;
    }

    // 4. Extension/MCP provider scope and exact tool filter
    const extensionsChoice = await ctx.ui.select("extensions (extension/MCP provider scope)", ["inherit all", "none", "custom names..."]);
    if (!extensionsChoice) return;

    let extensionsLine = "";
    if (extensionsChoice === "none") {
      extensionsLine = "\nextensions: false";
    } else if (extensionsChoice === "custom names...") {
      const customExtensions = await ctx.ui.input("extensions (comma-separated extension/MCP provider names)", "");
      if (customExtensions === undefined) return;
      if (customExtensions.trim()) extensionsLine = `\nextensions: ${customExtensions.trim()}`;
    }

    const extensionTools = await ctx.ui.input("extension_tools (exact extension/MCP tool names, optional; none = no extension tools)", "");
    if (extensionTools === undefined) return;
    const extensionToolsLine = extensionTools.trim() ? `\nextension_tools: ${extensionTools.trim()}` : "";

    // 4. Model
    const modelChoice = await ctx.ui.select("Model", [
      "inherit (parent model)",
      "haiku",
      "sonnet",
      "opus",
      "custom...",
    ]);
    if (!modelChoice) return;

    let modelLine = "";
    if (modelChoice === "haiku") modelLine = "\nmodel: anthropic/claude-haiku-4-5-20251001";
    else if (modelChoice === "sonnet") modelLine = "\nmodel: anthropic/claude-sonnet-4-6";
    else if (modelChoice === "opus") modelLine = "\nmodel: anthropic/claude-opus-4-6";
    else if (modelChoice === "custom...") {
      const customModel = await ctx.ui.input("Model (provider/modelId)");
      if (customModel) modelLine = `\nmodel: ${customModel}`;
    }

    // 5. Thinking
    const thinkingChoice = await ctx.ui.select("Thinking level", [
      "inherit",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    if (!thinkingChoice) return;

    let thinkingLine = "";
    if (thinkingChoice !== "inherit") thinkingLine = `\nthinking: ${thinkingChoice}`;

    // 6. Delegation policy
    const allowDelegationTo = await ctx.ui.input("Allow delegation to (comma-separated, optional)", "");
    if (allowDelegationTo === undefined) return;
    const disallowDelegationTo = await ctx.ui.input("Disallow delegation to (comma-separated, optional)", "");
    if (disallowDelegationTo === undefined) return;

    const allowDelegationLine = allowDelegationTo.trim()
      ? `\nallow_delegation_to: ${allowDelegationTo.trim()}`
      : "";
    const disallowDelegationLine = disallowDelegationTo.trim()
      ? `\ndisallow_delegation_to: ${disallowDelegationTo.trim()}`
      : "";

    // 7. System prompt
    const systemPrompt = await ctx.ui.editor("System prompt", "");
    if (systemPrompt === undefined) return;

    // Build the file
    const content = buildManualAgentMarkdown({
      description,
      builtinTools,
      extensionsLine,
      extensionToolsLine,
      modelLine,
      thinkingLine,
      allowDelegationLine,
      disallowDelegationLine,
      systemPrompt,
    });

    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);

    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Created ${targetPath}`, "info");
  }

  function snapshotSettings(): SubagentsSettings {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      defaultJoinMode: getDefaultJoinMode(),
    };
  }

  function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(),
      successMsg,
      (event, payload) => pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
  }

  async function showSettings(ctx: ExtensionCommandContext) {
    const choice = await ctx.ui.select("Settings", [
      `Max concurrency (current: ${manager.getMaxConcurrent()})`,
      `Default max turns (current: ${getDefaultMaxTurns() ?? "unlimited"})`,
      `Grace turns (current: ${getGraceTurns()})`,
      `Join mode (current: ${getDefaultJoinMode()})`,
    ]);
    if (!choice) return;

    if (choice.startsWith("Max concurrency")) {
      const val = await ctx.ui.input("Max concurrent background agents", String(manager.getMaxConcurrent()));
      if (val) {
        const n = parseInt(val, SUBAGENT_DECIMAL_RADIX);
        if (n >= 1) {
          manager.setMaxConcurrent(n);
          notifyApplied(ctx, `Max concurrency set to ${n}`);
        } else {
          ctx.ui.notify("Must be a positive integer.", "warning");
        }
      }
    } else if (choice.startsWith("Default max turns")) {
      const val = await ctx.ui.input("Default max turns before wrap-up (0 = unlimited)", String(getDefaultMaxTurns() ?? 0));
      if (val) {
        const n = parseInt(val, SUBAGENT_DECIMAL_RADIX);
        if (n === 0) {
          setDefaultMaxTurns(undefined);
          notifyApplied(ctx, "Default max turns set to unlimited");
        } else if (n >= 1) {
          setDefaultMaxTurns(n);
          notifyApplied(ctx, `Default max turns set to ${n}`);
        } else {
          ctx.ui.notify("Must be 0 (unlimited) or a positive integer.", "warning");
        }
      }
    } else if (choice.startsWith("Grace turns")) {
      const val = await ctx.ui.input("Grace turns after wrap-up steer", String(getGraceTurns()));
      if (val) {
        const n = parseInt(val, SUBAGENT_DECIMAL_RADIX);
        if (n >= 1) {
          setGraceTurns(n);
          notifyApplied(ctx, `Grace turns set to ${n}`);
        } else {
          ctx.ui.notify("Must be a positive integer.", "warning");
        }
      }
    } else if (choice.startsWith("Join mode")) {
      const val = await ctx.ui.select("Default join mode for background agents", [
        "smart — auto-group 2+ agents in same turn (default)",
        "async — always notify individually",
        "group — always group background agents",
      ]);
      if (val) {
        const mode = val.split(" ")[0] as JoinMode;
        setDefaultJoinMode(mode);
        notifyApplied(ctx, `Default join mode set to ${mode}`);
      }
    }
  }

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx); },
  });
}
