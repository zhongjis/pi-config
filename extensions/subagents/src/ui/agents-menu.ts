import { readFileSync } from "node:fs";
import { DynamicBorder, type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { formatAccessRules, resolveToolAccess, toolCandidates } from "../../../lib/active-tools.js";
import { type ModelRegistry, parseModelChain, resolveFirstAvailable } from "../../../lib/model-selection.js";
import { isGuardedBashType } from "../agent-runner.js";
import { type AgentToolHost } from "../agent-tool.js";
import { getAgentConfig, getAllTypes } from "../agent-types.js";
import { currentTargets } from "../research-delegation.js";
import type { AgentConfig, AgentRecord } from "../types.js";
import { type AgentActivity, formatDuration, getDisplayName } from "./agent-format.js";
import { type GraphRunMenuDeps, type GraphRunUIContext, showGraphRunsMenu } from "./graph-run-menu.js";

interface AgentMenuNavigation {
  readonly graphRuns: GraphRunMenuDeps;
  readonly showSettings: (ctx: ExtensionCommandContext) => Promise<void>;
}

export function createAgentsMenu(
  host: Pick<AgentToolHost, "pi" | "manager" | "reloadCustomAgents">,
  agentActivity: Map<string, AgentActivity>,
  navigation: AgentMenuNavigation,
) {
  const { pi, manager, reloadCustomAgents } = host;
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
      const done = agents.filter(a => a.status === "completed" || a.status === "force_steered").length;
      options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
    }
    if (allNames.length > 0) options.push(`Agent types (${allNames.length})`);
    options.push("Settings");
    options.push(`Graph runs (${navigation.graphRuns.tasks.size})`);
    const noAgentsMsg = allNames.length === 0 && agents.length === 0
      ? "No agents found. Define agents in your project or global agents directory."
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
    const hasCustom = allNames.some(n => getAgentConfig(n)?.enabled !== false);
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
      container.addChild(new DynamicBorder());
      container.addChild(new Text("Agent types", 0, 0));
      if (legendParts.length) container.addChild(new Text(slTheme.hint(legendParts.join("  ")), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      container.addChild(new DynamicBorder());
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
    const { openConversationOverlay } = await import("./conversation-overlay.js");
    await openConversationOverlay(ctx.ui, record, { manager, agentActivity });
  }

  async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    if (!cfg) {
      ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
      return;
    }
    // Rules are configuration; the resolved names depend on THIS session's tool registry.
    const resolved = resolveToolAccess(cfg.toolRules, toolCandidates(pi.getAllTools()), { allowNesting: currentTargets(cfg, isGuardedBashType).length > 0 }).allowed;
    const title = [
      name,
      `extensions: ${formatAccessRules(cfg.extensionRules) || "none"}`,
      `tools: ${formatAccessRules(cfg.toolRules) || "none"}`,
      `delegation: ${formatAccessRules(cfg.delegationRules ?? []) || "none"}`,
      `resolves here to: ${[...resolved].join(", ") || "none"}`,
    ].join("\n");
    const choice = await ctx.ui.select(title, ["View definition", "Back"]);
    if (choice === "View definition") {
      const content = cfg.definitionPath ? readFileSync(cfg.definitionPath, "utf-8") : cfg.systemPrompt;
      await ctx.ui.select(`${name} definition\n\n${content}`, ["Back"]);
    }
  }

  return { showAgentsMenu, viewAgentConversation };
}
