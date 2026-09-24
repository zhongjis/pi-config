import { createAgentResultBuilder } from "./agent-result.js";
import { createAgentTool } from "./agent-tool.js";
import { createGraphRuntime } from "./graph/graph-runtime.js";
import { createResultTools } from "./result-tools.js";
import { createAgentsMenu } from "./ui/agents-menu.js";
import { createSettingsMenu } from "./ui/settings-menu.js";
/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { AgentManager } from "./agent-manager.js";
import { registerAgentPolicyDenialResultHook } from "./agent-policy-denial-result.js";
import { getDefaultMaxTurns, getGraceTurns, SUBAGENT_TOOL_NAMES, setDefaultMaxTurns, setGraceTurns } from "./agent-runner.js";
import { getAvailableTypes, isDefaultsDisabled, registerAgents, setDefaultsDisabled } from "./agent-types.js";
import { type RpcHandle, registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { formatDelegationPolicyDenial, type ModeStateEntryLike, resolvePersistedDelegationPolicy } from "./delegation-policy.js";
import { GRAPH_RUN_ENTRY_TYPE, type GraphRunEntryData, graphRunEntryData } from "./graph/entry.js";
import { isHerdrPaneEnabled } from "./graph/pane/controller.js";
import { createGraphRunPaneManager, type GraphRunPaneManager } from "./graph/pane/manager.js";
import { graphSkillPath } from "./graph/tool-description.js";
import { createNotificationCoordinator } from "./notification-coordinator.js";
import { registerSubagentNotificationRenderer } from "./notification-rendering.js";
import { applyAndEmitLoaded, type SubagentsSettings, saveAndEmitChanged, type ToolDescriptionMode } from "./settings.js";
import { startBackgroundSupervision } from "./supervision-loop.js";
import { type AgentRecord, type JoinMode, type WidgetMode } from "./types.js";
import {
  type AgentActivity,
  AgentWidget,
  getDisplayName,
  type Theme,
  type UICtx,
} from "./ui/agent-widget.js";
import { FleetList, type FleetUICtx } from "./ui/fleet-list.js";
import { type GraphRunMenuDeps, openGraphRunFromFleet } from "./ui/graph-run-menu.js";
import { getLifetimeTotal, type LifetimeUsage, PendingUsagePool } from "./usage.js";

export { GRAPH_RUN_ENTRY_TYPE, type GraphRunEntryData, graphRunEntryData };

// ---- Shared helpers ----

/**
 * Read persisted session entries for delegation-policy resolution. Defensive:
 * returns [] when the session manager can't enumerate entries (e.g. a partial
 * ctx mock) so enforcement degrades to "unrestricted" instead of throwing.
 */
function readModeEntries(ctx: ExtensionContext): ModeStateEntryLike[] {
  const sm = (ctx as { sessionManager?: { getEntries?: () => unknown } }).sessionManager;
  if (typeof sm?.getEntries !== "function") return [];
  const entries = sm.getEntries();
  return Array.isArray(entries) ? (entries as ModeStateEntryLike[]) : [];
}

export function renderRunningAgentStatus(
  frame: string,
  statsText: string,
  activity: string,
  theme: Pick<Theme, "fg">,
): Container {
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", frame) + (statsText ? " " + statsText : ""), 0, 0));
  container.addChild(new Text(theme.fg("dim", `  ⎿  ${activity}`), 0, 0));
  return container;
}

export default function (pi: ExtensionAPI) {
  let reportUsage = false;
  let showCost = false;
  let pendingUsage = new PendingUsagePool();
  function setReportUsage(enabled: boolean): void {
    reportUsage = enabled;
    if (!enabled) pendingUsage = new PendingUsagePool();
  }
  function setShowCost(enabled: boolean): void { showCost = enabled; }

  // tool_result runs only for final results, including thrown/cancelled calls.
  // No execute/stream callback drains the pool, so cancellation cannot lose deltas.
  pi.on("tool_result", (event) => {
    if (!reportUsage || !event.toolCallId || !Object.values(SUBAGENT_TOOL_NAMES).some((name) => name === event.toolName)) return;
    const usage = pendingUsage.drain();
    if (!usage) return;
    const prior = event.usage;
    if (!prior) return { usage };
    return { usage: {
      ...prior,
      input: prior.input + usage.input,
      output: prior.output + usage.output,
      cacheRead: prior.cacheRead + usage.cacheRead,
      cacheWrite: prior.cacheWrite + usage.cacheWrite,
      totalTokens: prior.totalTokens + usage.totalTokens,
      cost: {
        input: prior.cost.input + usage.cost.input,
        output: prior.cost.output + usage.cost.output,
        cacheRead: prior.cost.cacheRead + usage.cost.cacheRead,
        cacheWrite: prior.cost.cacheWrite + usage.cost.cacheWrite,
        total: prior.cost.total + usage.cost.total,
      },
    } };
  });

  const buildDetails = createAgentResultBuilder(() => showCost);

  // Mark structured delegation-policy denials (details.category ===
  // "delegation_policy_denied") as tool errors so the LLM sees a failed Agent
  // call instead of a success. Registered once per activation.
  registerAgentPolicyDenialResultHook(pi);

  // ---- Register custom notification renderer ----
  registerSubagentNotificationRenderer(pi);

  /** Reload agents from project/global custom agent dirs and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = () => {
    const userAgents = loadCustomAgents(process.cwd());
    registerAgents(userAgents);
  };

  // Initial load
  reloadCustomAgents();

  // ---- Agent activity tracking + widget ----
  const agentActivity = new Map<string, AgentActivity>();

  const notifications = createNotificationCoordinator(pi, id => manager.getRecord(id), {
    activity: agentActivity,
    get widget() { return widget; },
    get fleet() { return fleet; },
  });
  const { schedule: scheduleNudge, cancel: cancelNudge } = notifications;

  /** Helper: build event data for lifecycle events from an AgentRecord. */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    // All three fields are lifetime-accumulated (Σ over every assistant message_end),
    // so they survive compaction together — input + output ≤ total always.
    // tokens is omitted when nothing was ever produced (e.g. agent errored before
    // any message_end fired), preserving prior payload shape.
    const u = record.lifetimeUsage;
    const total = getLifetimeTotal(u);
    const tokens = total > 0
      ? { input: u.input, output: u.output, total }
      : undefined;
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
    };
  }

  // Background completion: route through group join or send individual nudge
  const manager = new AgentManager((record) => {
    if (record.graphRunId !== undefined) return; // Owned children report only through their graph run.
    // Emit lifecycle event based on terminal status
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    // Persist final record for cross-extension history reconstruction
    pi.appendEntry("subagents:record", {
      id: record.id, type: record.type, description: record.description,
      status: record.status, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
    });

    notifications.onComplete(record);
  }, undefined, (record) => {
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  }, (record, info) => {
    // Emit compacted event when agent's session compacts (preserves count on record).
    pi.events.emit("subagents:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  });

  const collectManagerUsage = (usage: LifetimeUsage) => { if (reportUsage) pendingUsage.add(usage); };
  manager.setUsageListener(collectManagerUsage);

  // Inject the delegation-policy gate into the manager (defense in depth: the
  // Agent tool and RPC handler both deny earlier, but any spawn reaching the
  // manager is still gated). The manager stays free of session-state imports —
  // this closure reads the persisted agent-mode policy from the spawn ctx and
  // fails closed on denial.
  const resolveDelegation = (ctx: ExtensionContext, type: string) => resolvePersistedDelegationPolicy({
    entries: readModeEntries(ctx),
    availableTypes: getAvailableTypes(),
    requestedType: type,
  });
  const delegationDenial = (ctx: ExtensionContext, type: string): string | undefined => {
    const decision = resolveDelegation(ctx, type);
    return decision.decision.allowed
      ? undefined
      : formatDelegationPolicyDenial(decision, type);
  };
  manager.setPolicyChecker((ctx, type) => delegationDenial(ctx, type));

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  //
  // Claim the slot only if it's free: subagent sessions re-activate this
  // extension in the same process (session.bindExtensions in agent-runner.ts),
  // and unconditionally overwriting would point the registry at a short-lived
  // child manager — and the child's shutdown would then delete the root
  // session's entry. The first activation (the root session) wins; child
  // activations leave it alone.
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  const registryEntry = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: (piRef: any, ctx: any, type: string, prompt: string, options: any) =>
      manager.spawn(piRef, ctx, type, prompt, options),
    getRecord: (id: string) => manager.getRecord(id),
    getLifetimeCost: () => manager.getLifetimeCost(),
  };
  const ownsManagerRegistry = (globalThis as any)[MANAGER_KEY] === undefined;
  if (ownsManagerRegistry) {
    (globalThis as any)[MANAGER_KEY] = registryEntry;
  }

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;
  // RPC handlers + the `subagents:ready` broadcast are wired on `session_start`
  // (a bound lifecycle event), not at factory time. pi runs every extension
  // factory before the `extensions:` filter and only fires lifecycle events for
  // survivors, so a child session that filtered pi-subagents out never reaches
  // session_start — and must not advertise or answer RPC it can't service
  // (currentCtx would stay undefined → spawn always "No active session"). Gating
  // here makes a filtered session behave like an absent one (#142).
  let rpcHandle: RpcHandle | undefined;
  // Background auto-supervision loop handle. Started on session_start, stopped on
  // switch/shutdown. `undefined` = not running (used as the double-start guard).
  let supervisionStop: (() => void) | undefined;
  // The graph run inspector's Herdr side pane, constructed per activation. A
  // strict no-op when there is no Herdr-managed pane to split off, in which case
  // the in-Pi overlay stays the only inspector.
  let graphRunPane: GraphRunPaneManager | undefined;
  // Capture ctx from session_start for RPC spawn handler and broadcast readiness.
  // Wires RPC handlers on the first bound session_start so a filtered-out activation never advertises (#142).
  pi.on("session_start", async (_event, ctx) => {
    if (!ownsManagerRegistry) return;
    await stopGraphRuns("reload");
    await graphRuntime.loadHistory(ctx);
    currentCtx = ctx;
    pendingUsage = new PendingUsagePool();
    manager.setUsageListener(collectManagerUsage);
    manager.clearCompleted(true);
    manager.resetLifetimeCost();
    // Start the idle-agent auto-supervision loop once per activation (guarded so a
    // double-bound session_start can't stack intervals).
    if (!supervisionStop) {
      supervisionStop = startBackgroundSupervision(pi, manager, agentActivity);
    }
    // Guard: session_start fires once per activation, but a double-bind must not leak listeners.
    if (!rpcHandle) {
      rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => currentCtx,
        manager,
      });
      // Broadcast readiness so extensions loaded alongside us can discover us.
      // Emitting after all factories have run (rather than at factory time)
      // also avoids the race where a consumer loaded after us misses the event.
      pi.events.emit("subagents:ready", {});
    }
    // Rebuild the graph run inspector's side pane for this activation. Disposal
    // of any prior instance is defensive: a double-bound session_start must not
    // leak a controller or its timers.
    await graphRunPane?.dispose();
    graphRunPane = createGraphRunPaneManager({
      enabled: isHerdrPaneEnabled(process.env, ctx.mode),
      exec: (command, args, options) => pi.exec(command, args, options),
      parentPaneId: process.env.HERDR_PANE_ID ?? "",
      socket: process.env.HERDR_SOCKET_PATH ?? "",
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      ppid: process.pid,
      getTasks: () => getGraphRuns().values(),
      viewAgentConversation: (recordId) => {
        const record = manager.getRecord(recordId);
        if (currentCtx && record) return viewAgentConversation(currentCtx, record);
      },
      onError: (err, label) =>
        console.warn(`[pi-subagents] ${label}: ${err instanceof Error ? err.message : String(err)}`),
    });
    await graphRunPane.reconcile();
    if (isAgentGraphEnabled()) resumeDurableGraphRuns(ctx);
  });

  pi.on("session_before_switch", async () => {
    if (!ownsManagerRegistry) return;
    await stopGraphRuns("switch");
    manager.clearCompleted(true);
    supervisionStop?.();
    supervisionStop = undefined;
    await graphRunPane?.dispose();
    graphRunPane = undefined;
  });

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async (event) => {
    if (!ownsManagerRegistry) {
      manager.setUsageListener(undefined);
      pendingUsage = new PendingUsagePool();
      notifications.clearPending();
      fleet.dispose();
      widget.dispose();
      manager.dispose();
      return;
    }
    await stopGraphRuns(event?.reason === "reload" ? "reload" : "shutdown");
    await graphRunPane?.dispose();
    graphRunPane = undefined;
    manager.setUsageListener(undefined);
    pendingUsage = new PendingUsagePool();
    rpcHandle?.unsubSpawn();
    rpcHandle?.unsubStop();
    rpcHandle?.unsubPing();
    rpcHandle = undefined;
    currentCtx = undefined;
    supervisionStop?.();
    supervisionStop = undefined;
    // Only release the global slot if this activation claimed it — a child
    // session's shutdown must not delete the root session's registry entry.
    if (ownsManagerRegistry && (globalThis as any)[MANAGER_KEY] === registryEntry) {
      delete (globalThis as any)[MANAGER_KEY];
    }
    manager.abortAll();
    notifications.clearPending();
    fleet.dispose();
    manager.dispose();
  });

  // Live widget: show running agents above editor.
  // widgetMode (default "background") selects what the widget shows: "all" =
  // every agent; "background" = hide foreground (they already render inline as
  // the Agent tool result, so showing them here too is a duplicate, #118), keep
  // everything else; "off" = hide the widget entirely. Read live at render time.
  let widgetMode: WidgetMode = "background";
  function getWidgetMode(): WidgetMode { return widgetMode; }
  const widget = new AgentWidget(manager, agentActivity, getWidgetMode);
  function setWidgetMode(m: WidgetMode): void { widgetMode = m; widget.update(); }

  // Claude Code-style FleetView: navigable list of main + subagents below the editor.
  const fleet = new FleetList(manager, agentActivity);
  let fleetViewEnabled = true;
  function isFleetViewEnabled(): boolean { return fleetViewEnabled; }
  function setFleetViewEnabled(b: boolean): void { fleetViewEnabled = b; fleet.setEnabled(b); }

  // Project/global default for writing the subagent .output transcript. A custom
  // agent's `output_transcript` frontmatter overrides this per spawn; when the
  // frontmatter is silent, this default applies. Read live at spawn time.
  let outputTranscriptDefault = true;
  function getOutputTranscriptDefault(): boolean { return outputTranscriptDefault; }
  function setOutputTranscript(b: boolean): void { outputTranscriptDefault = b; }

  // ---- Join mode configuration ----
  let defaultJoinMode: JoinMode = 'smart';
  function getDefaultJoinMode(): JoinMode { return defaultJoinMode; }
  function setDefaultJoinMode(mode: JoinMode) { defaultJoinMode = mode; }

  // ---- Scope models configuration ----
  // When enabled, subagent model choices are validated against `enabledModels`
  // from pi's settings — both global `<agentDir>/settings.json` and
  // project-local `<cwd>/.pi/settings.json` (project overrides global).
  // Off by default; opt-in via `/agents → Settings`. See docstring on
  // SubagentsSettings.scopeModels for the hard-error vs warn-and-proceed
  // policy and its rationale.
  let scopeModelsEnabled = false;
  function isScopeModelsEnabled(): boolean { return scopeModelsEnabled; }
  function setScopeModelsEnabled(enabled: boolean): void { scopeModelsEnabled = enabled; }

  // ---- Disable default agents configuration ----
  // When enabled, the three hardcoded default agents (general-purpose, Explore,
  // Plan) are not registered. User-defined agents from project/global custom
  // agent dirs are completely unaffected — only DEFAULT_AGENTS are suppressed.
  // Defaults to false; opt-in via `/agents → Settings` or subagents.json.
  // State lives in agent-types.ts (isDefaultsDisabled) because registerAgents
  // needs it; this wrapper just re-registers after flipping it.
  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents(); // re-register with new setting
  }

  // Registration is fixed at activation; settings changes apply on reload.
  let agentGraphEnabled = false;
  function isAgentGraphEnabled(): boolean { return agentGraphSessionEnabled; }
  function setAgentGraphEnabled(enabled: boolean): void {
    agentGraphEnabled = enabled;
  }

  // ---- Agent tool description mode ----
  // "full" (default) keeps the rich Claude Code-style description; "compact"
  // swaps in a ~75% smaller one for small/local models (#91). Read once at
  // tool registration — flipping it applies on the next pi session.
  let toolDescriptionMode: ToolDescriptionMode = "full";
  function getToolDescriptionMode(): ToolDescriptionMode { return toolDescriptionMode; }
  function setToolDescriptionMode(mode: ToolDescriptionMode): void { toolDescriptionMode = mode; }

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    widget.onTurnStart();
  });

  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults.
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setMaxConcurrentForeground: (n) => manager.setMaxConcurrentForeground(n),
      setReportUsage,
      setAgentGraphEnabled,
      setShowCost,
      setDefaultMaxTurns,
      setGraceTurns,
      setDefaultJoinMode,
      setScopeModels: setScopeModelsEnabled,
      setDisableDefaultAgents: setDisableDefaultAgents,
      setToolDescriptionMode: setToolDescriptionMode,
      setFleetView: setFleetViewEnabled,
      setWidgetMode: setWidgetMode,
      setOutputTranscript: setOutputTranscript,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  let agentGraphSessionEnabled = agentGraphEnabled;

  pi.registerTool(createAgentTool(
    {
      pi, manager, reloadCustomAgents, resolveDelegation,
      settings: {
        get defaultJoinMode() { return defaultJoinMode; },
        get scopeModels() { return scopeModelsEnabled; },
        get outputTranscript() { return outputTranscriptDefault; },
        get toolDescriptionMode() { return toolDescriptionMode; },
        get showCost() { return showCost; },
      },
    },
    { activity: agentActivity, widget, fleet },
    notifications,
  ));

  const graphRuntime = createGraphRuntime(
    { pi, manager, enabled: isAgentGraphEnabled, scopeModels: isScopeModelsEnabled, outputTranscript: getOutputTranscriptDefault, delegationDenial },
    { schedule: scheduleNudge, cancel: cancelNudge },
    surface => {
      if (surface !== "pane") { widget.update(); fleet.update(); }
      if (surface !== "fleet") graphRunPane?.sync();
    },
  );
  const { getRuns: getGraphRuns, resume: resumeDurableGraphRuns, stop: stopGraphRuns, fleetGraphRuns } = graphRuntime;

  if (isAgentGraphEnabled()) {
    pi.on("resources_discover", () => (isAgentGraphEnabled() ? { skillPaths: [graphSkillPath] } : undefined));
  }
  if (isAgentGraphEnabled()) pi.registerTool(graphRuntime.tool);

  const resultTools = createResultTools(pi, manager, {
    details: record => buildDetails(
      { displayName: getDisplayName(record.type), description: record.description, subagentType: record.type },
      record,
      { activity: agentActivity.get(record.id) },
    ),
    cancelNudge,
  });
  pi.registerTool(resultTools.getResult);
  pi.registerTool(resultTools.steer);

  const showSettings = createSettingsMenu(snapshotSettings, applySettingValue);
  const { showAgentsMenu, viewAgentConversation } = createAgentsMenu(
    { pi, manager, reloadCustomAgents },
    agentActivity,
    {
      get agentGraphEnabled() { return isAgentGraphEnabled(); },
      get graphRuns() { return graphRunMenuDeps; },
      showSettings,
    },
  );

  function snapshotSettings(): Required<SubagentsSettings> {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      maxConcurrentForeground: manager.getMaxConcurrentForeground(),
      reportUsage,
      agentGraphEnabled,
      showCost,
      // 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
      // normalizeMaxTurns() in agent-runner.ts (which maps 0 → undefined).
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      defaultJoinMode: getDefaultJoinMode(),
      scopeModels: isScopeModelsEnabled(),
      disableDefaultAgents: isDefaultsDisabled(),
      toolDescriptionMode: getToolDescriptionMode(),
      fleetView: isFleetViewEnabled(),
      widgetMode: getWidgetMode(),
      outputTranscript: getOutputTranscriptDefault(),
    };
  }

  function applySettingValue(ctx: ExtensionCommandContext, id: string, value: string) {
    if (id === "agentGraphEnabled") {
      setAgentGraphEnabled(value === "on");
      notifyApplied(ctx, `Agent graphs ${agentGraphEnabled ? "enabled" : "disabled"} for the next reload.`);
    } else if (id === "maxConcurrent") {
      const n = parseInt(value, 10);
      if (n >= 1) {
        manager.setMaxConcurrent(n);
        notifyApplied(ctx, `Max concurrency set to ${n}`);
      }
    } else if (id === "maxConcurrentForeground") {
      const n = Number(value);
      if (Number.isInteger(n) && n >= 0 && n <= 1024) {
        manager.setMaxConcurrentForeground(n);
        notifyApplied(ctx, `Foreground concurrency set to ${n || "unlimited"}`);
      }
    } else if (id === "reportUsage") {
      setReportUsage(value === "on");
      notifyApplied(ctx, `Usage reporting ${reportUsage ? "enabled" : "disabled"}`);
    } else if (id === "showCost") {
      setShowCost(value === "on");
      notifyApplied(ctx, `Expanded cost ${showCost ? "enabled" : "disabled"}`);
    } else if (id === "defaultMaxTurns") {
      const n = parseInt(value, 10);
      if (n === 0) {
        setDefaultMaxTurns(undefined);
        notifyApplied(ctx, "Default max turns set to unlimited");
      } else if (n >= 1) {
        setDefaultMaxTurns(n);
        notifyApplied(ctx, `Default max turns set to ${n}`);
      }
    } else if (id === "graceTurns") {
      const n = parseInt(value, 10);
      if (n >= 1) {
        setGraceTurns(n);
        notifyApplied(ctx, `Grace turns set to ${n}`);
      }
    } else if (id === "joinMode") {
      setDefaultJoinMode(value as JoinMode);
      notifyApplied(ctx, `Default join mode set to ${value}`);
    } else if (id === "scopeModels") {
      const enabled = value === "on";
      setScopeModelsEnabled(enabled);
      notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "disableDefaultAgents") {
      const enabled = value === "on";
      setDisableDefaultAgents(enabled);
      notifyApplied(ctx, `Default agents ${enabled ? "disabled" : "enabled"}. Tool spec change takes effect on next pi session.`);
    } else if (id === "outputTranscript") {
      const enabled = value === "on";
      setOutputTranscript(enabled);
      notifyApplied(ctx, `Output transcript ${enabled ? "enabled" : "disabled"} by default`);
    } else if (id === "toolDescriptionMode") {
      setToolDescriptionMode(value as ToolDescriptionMode);
      notifyApplied(ctx, `Tool description set to ${value}. Takes effect on next pi session.`);
    } else if (id === "fleetView") {
      const enabled = value === "on";
      setFleetViewEnabled(enabled);
      notifyApplied(ctx, `Fleet view ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "widgetMode") {
      setWidgetMode(value as WidgetMode);
      notifyApplied(ctx, `Widget set to ${value}`);
    }
  }

  // Persist the current snapshot, emit `subagents:settings_changed`, and surface
  // the right toast. Successful saves show info; persistence failures downgrade
  // to warning so users aren't silently reverted on restart. Event fires regardless
  // of outcome so listeners see the in-memory change.
  function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(),
      successMsg,
      (event, payload) => pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
  }

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx); },
  });
  pi.registerCommand("graph-runs", {
    description: "Open/reopen the graph run monitor in a Herdr side pane",
    handler: async (_args, ctx) => {
      // Clears any manual-close flag and force-opens for the active run. Off the
      // Herdr path there is nothing to open, so say why rather than doing nothing.
      if (!graphRunPane?.isEnabled()) {
        ctx.ui.notify("Graph run monitor needs a Herdr-managed pane.", "warning");
        return;
      }
      await graphRunPane.forceOpen();
    },
  });
  const graphRunMenuDeps: GraphRunMenuDeps = {
    get tasks() { return getGraphRuns(); },
    getRecord: id => manager.getRecord(id),
    viewAgentConversation,
    // Read lazily: `currentCtx` is rebound on every session_start, and the
    // fleet list may act between sessions, when there is none.
    getCtx: () => currentCtx,
  };

  fleet.setGraphRunSource(fleetGraphRuns, id => openGraphRunFromFleet(id, graphRunMenuDeps));
}
