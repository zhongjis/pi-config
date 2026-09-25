import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type AgentSession, type ExtensionCommandContext, getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { type ModelRegistry, parseModelChain, resolveFirstAvailable } from "../../../lib/model-selection.js";
import { readHistoryConversation } from "../agent-history.js";
import { type AgentToolHost, THINKING_LEVELS } from "../agent-tool.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAllTypes } from "../agent-types.js";
import type { AgentConfig, AgentRecord } from "../types.js";
import { type AgentActivity, formatDuration, getDisplayName } from "./agent-widget.js";
import { type GraphRunMenuDeps, type GraphRunUIContext, showGraphRunsMenu } from "./graph-run-menu.js";

interface AgentMenuNavigation {
  readonly agentGraphEnabled: boolean;
  readonly graphRuns: GraphRunMenuDeps;
  readonly showSettings: (ctx: ExtensionCommandContext) => Promise<void>;
}

// allow: SIZE_OK — the agent-management navigation owns its CRUD and authoring wizard flow.
export function createAgentsMenu(
  host: Pick<AgentToolHost, "pi" | "manager" | "reloadCustomAgents">,
  agentActivity: Map<string, AgentActivity>,
  navigation: AgentMenuNavigation,
) {
  const { pi, manager, reloadCustomAgents } = host;
  const projectAgentsDir = () => join(process.cwd(), ".pi", "agents");
  const workspaceAgentsDir = () => join(process.cwd(), ".agents", "agents");
  const personalAgentsDir = () => join(getAgentDir(), "agents");

  /** Discovery precedence: project, workspace, then global. */
  function findAgentFile(name: string): { path: string; location: "project" | "workspace" | "personal" } | undefined {
    const projectPath = join(projectAgentsDir(), `${name}.md`);
    if (existsSync(projectPath)) return { path: projectPath, location: "project" };
    const workspacePath = join(workspaceAgentsDir(), `${name}.md`);
    if (existsSync(workspacePath)) return { path: workspacePath, location: "workspace" };
    const personalPath = join(personalAgentsDir(), `${name}.md`);
    if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
    return undefined;
  }

  function getModelLabelFromConfig(model: string): string {
    const name = model.includes("/") ? model.split("/").pop()! : model;
    return name.replace(/-\d{8}$/, "");
  }

  function getModelLabel(type: string, registry?: ModelRegistry): string {
    const cfg = getAgentConfig(type);
    if (!cfg?.model) return "inherit";
    const label = getModelLabelFromConfig(cfg.model);
    if (!registry) return label;
    const selected = resolveFirstAvailable(parseModelChain(cfg.model), registry);
    if (!selected) return `${label} (unavailable)`;
    const resolved = selected.model;
    const resolvedFull = `${resolved.provider}/${resolved.id}`;
    const norm = (s: string) => s.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
    if (norm(cfg.model) === norm(resolvedFull)) return label;
    return `${label} (→ ${resolvedFull.replace(/-\d{8}$/, "")})`;
  }

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    reloadCustomAgents();
    const allNames = getAllTypes();
    const options: string[] = [];
    const agents = manager.listAgents().filter(agent => agent.graphRunId === undefined);
    if (agents.length > 0) {
      const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
      const done = agents.filter(a => a.status === "completed" || a.status === "steered").length;
      options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
    }
    if (allNames.length > 0) options.push(`Agent types (${allNames.length})`);
    options.push("Create new agent");
    options.push("Settings");
    if (navigation.agentGraphEnabled) options.push(`Graph runs (${navigation.graphRuns.tasks.size})`);
    const noAgentsMsg = allNames.length === 0 && agents.length === 0
      ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
        "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
        "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
      : "";
    if (noAgentsMsg) ctx.ui.notify(noAgentsMsg, "info");
    const choice = await ctx.ui.select("Agents", options);
    if (!choice) return;
    if (choice.startsWith("Running agents (")) {
      await showRunningAgents(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Agent types (")) {
      await showAllAgentsList(ctx);
      await showAgentsMenu(ctx);
    } else if (choice === "Create new agent") {
      await showCreateWizard(ctx);
    } else if (choice.startsWith("Graph runs (")) {
      await showGraphRunsMenu(ctx, navigation.graphRuns);
      await showAgentsMenu(ctx);
    } else if (choice === "Settings") {
      await navigation.showSettings(ctx);
      await showAgentsMenu(ctx);
    }
  }

  async function showAllAgentsList(ctx: ExtensionCommandContext) {
    const allNames = getAllTypes();
    if (allNames.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }
    const sourceIndicator = (cfg: AgentConfig | undefined) => {
      const disabled = cfg?.enabled === false;
      if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
      if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
      if (disabled) return "✕  ";
      return "   ";
    };
    const items: SettingItem[] = allNames.map(name => {
      const cfg = getAgentConfig(name);
      const disabled = cfg?.enabled === false;
      const model = getModelLabel(name, ctx.modelRegistry);
      return {
        id: name,
        label: `${sourceIndicator(cfg)}${name}`,
        currentValue: model,
        description: disabled ? "(disabled)" : (cfg?.description ?? name),
        values: [model],
      };
    });
    const hasCustom = allNames.some(n => { const c = getAgentConfig(n); return c && !c.isDefault && c.enabled !== false; });
    const hasDisabled = allNames.some(n => getAgentConfig(n)?.enabled === false);
    const legendParts: string[] = [];
    if (hasCustom) legendParts.push("• = project  ◦ = global");
    if (hasDisabled) legendParts.push("✕ = disabled");
    const selected = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const slTheme = getSettingsListTheme();
      const list = new SettingsList(
        items,
        Math.min(items.length, 12),
        slTheme,
        id => done(id),
        () => done(undefined),
      );
      const container = new Container();
      container.addChild(new Text("Agent types", 0, 0));
      if (legendParts.length) container.addChild(new Text(slTheme.hint(legendParts.join("  ")), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => list.handleInput?.(data),
      };
    });
    if (selected && getAgentConfig(selected)) {
      await showAgentDetail(ctx, selected);
      await showAllAgentsList(ctx);
    }
  }

  async function showRunningAgents(ctx: ExtensionCommandContext) {
    const agents = manager.listAgents().filter(agent => agent.graphRunId === undefined);
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
    const idx = options.indexOf(choice);
    if (idx < 0) return;
    const record = agents[idx];
    await viewAgentConversation(ctx, record);
    await showRunningAgents(ctx);
  }

  async function viewAgentConversation(ctx: GraphRunUIContext, record: AgentRecord) {
    if (!record.session && record.sessionFile) {
      const messages = await readHistoryConversation(record.sessionFile);
      if (messages === undefined) {
        ctx.ui.notify("Conversation file is no longer available.", "info");
        return;
      }
      const { ConversationViewer, VIEWPORT_HEIGHT_PCT } = await import("./conversation-viewer.js");
      const session = { messages, subscribe: () => () => {} } as unknown as AgentSession;
      await ctx.ui.custom<undefined>(
        (tui, theme, keybindings, done) => new ConversationViewer(tui, session, record, undefined, theme, done, undefined, keybindings),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
        },
      );
      return;
    }
    if (!record.session) {
      ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info");
      return;
    }
    const { ConversationViewer, VIEWPORT_HEIGHT_PCT } = await import("./conversation-viewer.js");
    const session = record.session;
    const activity = agentActivity.get(record.id);
    await ctx.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        return new ConversationViewer(tui, session, record, activity, theme, done, () => {
          if (manager.abort(record.id)) ctx.ui.notify(`Stopped "${record.description}".`, "info");
        }, keybindings, (message: string) => manager.steer(record.id, message));
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
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
    } else if (choice === "Reset to default" && file) {
      const confirmed = await ctx.ui.confirm("Reset to default", `Delete override ${file.path} and restore embedded default?`);
      if (confirmed) {
        unlinkSync(file.path);
        reloadCustomAgents();
        ctx.ui.notify(`Restored default ${name}`, "info");
      }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
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
    const fmFields: string[] = [];
    fmFields.push(`description: ${JSON.stringify(cfg.description)}`);
    if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`);
    if (cfg.builtinToolNames) fmFields.push(`builtin_tools: ${cfg.builtinToolNames.join(", ") || "none"}`);
    if (cfg.extensionToolNames) fmFields.push(`extension_tools: ${cfg.extensionToolNames.join(", ") || "none"}`);
    if (cfg.model) fmFields.push(`model: ${cfg.model}`);
    if (cfg.thinking) fmFields.push(`thinking: ${cfg.thinking}`);
    if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
    fmFields.push(`prompt_mode: ${cfg.promptMode}`);
    if (cfg.extensions === false) fmFields.push("extensions: false");
    else if (Array.isArray(cfg.extensions)) fmFields.push(`extensions: ${cfg.extensions.join(", ")}`);
    if (cfg.excludeExtensions?.length) fmFields.push(`exclude_extensions: ${cfg.excludeExtensions.join(", ")}`);
    if (!cfg.discoverSkills) fmFields.push("discover_skills: false");
    if (cfg.preloadSkills?.length) fmFields.push(`preload_skills: ${cfg.preloadSkills.join(", ")}`);
    if (cfg.inheritContext) fmFields.push("inherit_context: true");
    if (cfg.runInBackground) fmFields.push("run_in_background: true");
    if (cfg.outputTranscript === false) fmFields.push("output_transcript: false");
    if (cfg.isolated) fmFields.push("isolated: true");
    const content = `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  async function disableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (file) {
      const content = readFileSync(file.path, "utf-8");
      if (content.includes("\nenabled: false\n")) {
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

  async function enableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (!file) return;
    const content = readFileSync(file.path, "utf-8");
    const updated = content.replace(/^(---\n)enabled: false\n/, "$1");
    const { writeFileSync } = await import("node:fs");
    if (updated.trim() === "---\n---" || updated.trim() === "---\n---\n") {
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
    if (method.startsWith("Generate")) await showGenerateWizard(ctx, targetDir);
    else await showManualWizard(ctx, targetDir);
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
    const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
builtin_tools: <comma-separated built-in tools: read, bash, edit, write, grep, find, ls. Use "none" for no built-in tools. Omit for all>
extension_tools: <comma-separated extension/MCP tool names (exact or trailing-* wildcard, e.g. codegraph_*). Use "none" for none. Omit for all>
model: <optional model as "provider/modelId", e.g. "anthropic/claude-haiku-4-5". Omit to inherit parent model>
thinking: <optional thinking level: ${THINKING_LEVELS.join(", ")}. Omit for model default>
max_turns: <optional max agentic turns. 0 or omit for unlimited (default)>
prompt_mode: <"replace" (body IS the full system prompt) or "append" (body is appended to default prompt). Default: replace>
extensions: <true (inherit all MCP/extension tools), false (none), or comma-separated names. Default: true>
discover_skills: <false to disable the on-demand skill catalog. Default: true>
preload_skills: <comma-separated skill names to eagerly inject into the prompt. Omit for none>
inherit_context: <true to fork parent conversation into agent so it sees chat history. Default: false>
run_in_background: <true to run in background by default. Default: false>
output_transcript: <false to write no transcript file or path for this agent. Independent of persist_session. Default: true>
isolated: <true for no extension/MCP tools, only built-in tools. Default: false>
---

<system prompt body — instructions for the agent>
\`\`\`

Guidelines for choosing settings:
- For read-only tasks (review, analysis): builtin_tools: read, bash, grep, find, ls
- For code modification tasks: include edit, write
- Use prompt_mode: append if the agent should keep the default system prompt and add specialization on top
- Use prompt_mode: replace for fully custom agents with their own personality/instructions
- Set inherit_context: true if the agent needs to know what was discussed in the parent conversation
- Set isolated: true if the agent should NOT have access to MCP servers or other extensions
- Set output_transcript: false to skip writing this agent's transcript; this alone doesn't keep the run off disk (persist_session still writes) — set it too if that's the goal
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Write the file using the write tool. Only write the file, nothing else.`;
    const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose", generatePrompt, {
      description: `Generate ${name} agent`,
      maxTurns: 5,
    });
    if (record.status === "error") {
      ctx.ui.notify(`Generation failed: ${record.error}`, "warning");
      return;
    }
    reloadCustomAgents();
    if (existsSync(targetPath)) ctx.ui.notify(`Created ${targetPath}`, "info");
    else ctx.ui.notify("Agent generation completed but file was not created. Check the agent output.", "warning");
  }

  async function showManualWizard(ctx: ExtensionCommandContext, targetDir: string) {
    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;
    const description = await ctx.ui.input("Description (one line)");
    if (!description) return;
    const toolChoice = await ctx.ui.select("Tools", ["all", "none", "read-only (read, bash, grep, find, ls)", "custom..."]);
    if (!toolChoice) return;
    let tools: string;
    if (toolChoice === "all") tools = BUILTIN_TOOL_NAMES.join(", ");
    else if (toolChoice === "none") tools = "none";
    else if (toolChoice.startsWith("read-only")) tools = "read, bash, grep, find, ls";
    else {
      const customTools = await ctx.ui.input("Tools (comma-separated)", BUILTIN_TOOL_NAMES.join(", "));
      if (!customTools) return;
      tools = customTools;
    }
    const modelChoice = await ctx.ui.select("Model", [
      "inherit (parent model)",
      "haiku",
      "sonnet",
      "opus",
      "custom...",
    ]);
    if (!modelChoice) return;
    let modelLine = "";
    if (modelChoice === "haiku") modelLine = "\nmodel: anthropic/claude-haiku-4-5";
    else if (modelChoice === "sonnet") modelLine = "\nmodel: anthropic/claude-sonnet-4-6";
    else if (modelChoice === "opus") modelLine = "\nmodel: anthropic/claude-opus-4-6";
    else if (modelChoice === "custom...") {
      const customModel = await ctx.ui.input("Model (provider/modelId)");
      if (customModel) modelLine = `\nmodel: ${customModel}`;
    }
    const thinkingChoice = await ctx.ui.select("Thinking level", ["model default", ...THINKING_LEVELS]);
    if (!thinkingChoice) return;
    let thinkingLine = "";
    if (thinkingChoice !== "model default") thinkingLine = `\nthinking: ${thinkingChoice}`;
    const systemPrompt = await ctx.ui.editor("System prompt", "");
    if (systemPrompt === undefined) return;
    const content = `---
description: ${description}
builtin_tools: ${tools}${modelLine}${thinkingLine}
prompt_mode: replace
---

${systemPrompt}
`;
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

  return { showAgentsMenu, viewAgentConversation };
}
