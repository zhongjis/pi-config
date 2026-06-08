import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AutoClearManager } from "../auto-clear.js";
import { AUTO_CLEAR_DELAY, REMINDER_INTERVAL } from "../constants.js";
import { ContinuationCooldown } from "../continuation-cooldown.js";
import { ProcessTracker } from "../process-tracker.js";
import { TaskStore } from "../task-store.js";
import { loadTasksConfig } from "../tasks-config.js";
import { TaskWidget, type UICtx } from "../ui/task-widget.js";

export const DEBUG = !!process.env.PI_TASKS_DEBUG;

export function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-tasks]", ...args);
}

export function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

export const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute"]);

export type SessionStateContext = {
  sessionManager: {
    getEntries(): Array<{ type?: string; customType?: string; data?: { mode?: unknown } }>;
    getSessionId(): string;
  };
};

const PI_WORKFLOW_PHASE_KEY = "_piWorkflowPhase";
const PI_ORIGIN_MODE_KEY = "_piOriginMode";
const PI_ORIGIN_SESSION_ID_KEY = "_piOriginSessionId";
export const RESERVED_PROVENANCE_KEYS = new Set([
  PI_WORKFLOW_PHASE_KEY,
  PI_ORIGIN_MODE_KEY,
  PI_ORIGIN_SESSION_ID_KEY,
]);

export function getCurrentMode(ctx?: SessionStateContext): string | undefined {
  const entries = ctx?.sessionManager.getEntries() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== "agent-mode") continue;
    if (typeof entry.data?.mode === "string" && entry.data.mode.trim()) {
      return entry.data.mode;
    }
  }
  return undefined;
}

export function sanitizeUserMetadata(metadata?: Record<string, any>): { metadata?: Record<string, any>; ignoredKeys: string[] } {
  if (!metadata) return { metadata: undefined, ignoredKeys: [] };

  const cleanMetadata: Record<string, any> = {};
  const ignoredKeys: string[] = [];

  for (const [key, value] of Object.entries(metadata)) {
    if (RESERVED_PROVENANCE_KEYS.has(key)) {
      ignoredKeys.push(key);
      continue;
    }
    cleanMetadata[key] = value;
  }

  return {
    metadata: Object.keys(cleanMetadata).length > 0 ? cleanMetadata : undefined,
    ignoredKeys,
  };
}

export function buildTaskMetadata(
  metadata: Record<string, any> | undefined,
  ctx?: SessionStateContext,
): { metadata?: Record<string, any>; ignoredKeys: string[] } {
  const { metadata: cleanMetadata, ignoredKeys } = sanitizeUserMetadata(metadata);
  const nextMetadata = cleanMetadata ? { ...cleanMetadata } : {};

  if (ctx && getCurrentMode(ctx) === "fuxi") {
    nextMetadata[PI_WORKFLOW_PHASE_KEY] = "planning";
    nextMetadata[PI_ORIGIN_MODE_KEY] = "fuxi";
    nextMetadata[PI_ORIGIN_SESSION_ID_KEY] = ctx.sessionManager.getSessionId();
  }

  return {
    metadata: Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined,
    ignoredKeys,
  };
}

export function isPlanningTaskMetadataForSession(metadata: Record<string, any>, sessionId: string): boolean {
  return metadata?.[PI_WORKFLOW_PHASE_KEY] === "planning" &&
    metadata?.[PI_ORIGIN_MODE_KEY] === "fuxi" &&
    metadata?.[PI_ORIGIN_SESSION_ID_KEY] === sessionId;
}

export const SYSTEM_REMINDER = `<system-reminder>
The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user
</system-reminder>`;

export type TaskRuntime = {
  cfg: ReturnType<typeof loadTasksConfig>;
  piTasks: string | undefined;
  taskScope: string;
  store: TaskStore;
  tracker: ProcessTracker;
  widget: TaskWidget;
  autoClear: AutoClearManager;
  latestCtx: ExtensionContext | undefined;
  cascadeConfig: { additionalContext?: string; model?: string; maxTurns?: number } | undefined;
  agentTaskMap: Map<string, string>;
  subagentsAvailable: boolean;
  pendingWarning: string | undefined;
  storeUpgraded: boolean;
  persistedTasksShown: boolean;
  currentTurn: number;
  lastTaskToolUseTurn: number;
  continuationCooldown: ContinuationCooldown;
  reminderDue: boolean;
  resolveStorePath(sessionId?: string): string | undefined;
};

export function createTaskRuntime(): TaskRuntime {
  const cfg = loadTasksConfig();
  const piTasks = process.env.PI_TASKS;
  const taskScope = cfg.taskScope ?? "session";
  const runtime = {
    cfg,
    piTasks,
    taskScope,
    store: undefined as unknown as TaskStore,
    tracker: new ProcessTracker(),
    widget: undefined as unknown as TaskWidget,
    autoClear: undefined as unknown as AutoClearManager,
    latestCtx: undefined,
    cascadeConfig: undefined,
    agentTaskMap: new Map<string, string>(),
    subagentsAvailable: false,
    pendingWarning: undefined,
    storeUpgraded: false,
    persistedTasksShown: false,
    currentTurn: 0,
    lastTaskToolUseTurn: 0,
    continuationCooldown: new ContinuationCooldown(REMINDER_INTERVAL),
    reminderDue: false,
    resolveStorePath(sessionId?: string): string | undefined {
      if (piTasks === "off") return undefined;
      if (piTasks?.startsWith("/")) return piTasks;
      if (piTasks?.startsWith(".")) return resolve(piTasks);
      if (piTasks) return piTasks;
      if (taskScope === "memory") return undefined;
      if (taskScope === "session" && sessionId) {
        return join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
      }
      if (taskScope === "session") return undefined;
      return join(process.cwd(), ".pi", "tasks", "tasks.json");
    },
  } satisfies TaskRuntime;

  runtime.store = new TaskStore(runtime.resolveStorePath());
  runtime.widget = new TaskWidget(runtime.store);
  runtime.autoClear = new AutoClearManager(() => runtime.store, () => cfg.autoClearCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY);
  return runtime;
}

export function upgradeStoreIfNeeded(runtime: TaskRuntime, ctx: ExtensionContext) {
  if (runtime.storeUpgraded) return;
  if (runtime.taskScope === "session" && !runtime.piTasks) {
    const sessionId = ctx.sessionManager.getSessionId();
    const path = runtime.resolveStorePath(sessionId);
    runtime.store = new TaskStore(path);
    runtime.widget.setStore(runtime.store);
  }
  runtime.storeUpgraded = true;
}

export function showPersistedTasks(runtime: TaskRuntime, isResume = false) {
  if (runtime.persistedTasksShown) return;
  runtime.persistedTasksShown = true;
  const tasks = runtime.store.list();
  if (tasks.length > 0) {
    if (!isResume && tasks.every(t => t.status === "completed")) {
      runtime.store.clearCompleted();
      if (runtime.taskScope === "session") runtime.store.deleteFileIfEmpty();
    } else {
      runtime.widget.update();
    }
  }
}

export function registerLifecycleEvents(pi: ExtensionAPI, runtime: TaskRuntime) {
  pi.on("turn_start", async (_event, ctx) => {
    runtime.currentTurn++;
    runtime.latestCtx = ctx;
    runtime.widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(runtime, ctx);
    if (runtime.autoClear.onTurnStart(runtime.currentTurn)) runtime.widget.update();
  });

  pi.on("turn_end", async (event) => {
    const msg = event.message as any;
    if (msg?.role === "assistant" && msg.usage) {
      runtime.widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0);
    }
  });

  pi.on("tool_result", async (event) => {
    if (TASK_TOOL_NAMES.has(event.toolName)) {
      runtime.lastTaskToolUseTurn = runtime.currentTurn;
      runtime.continuationCooldown.recordProgress();
      return {};
    }

    const turnsSinceProgress = runtime.currentTurn - runtime.lastTaskToolUseTurn;
    if (!runtime.continuationCooldown.shouldFire(turnsSinceProgress)) {
      if (
        runtime.continuationCooldown.stagnant &&
        turnsSinceProgress >= runtime.continuationCooldown.nextInterval
      ) {
        const tasks = runtime.store.list();
        if (tasks.length > 0) {
          const stagnation = runtime.continuationCooldown.consumeStagnationWarning();
          if (stagnation) {
            console.warn("[panda-warn]", JSON.stringify({
              code: "subagent.continuation.stagnation-cap",
              ts: Date.now(),
              attempt: stagnation.attempt,
              cap: stagnation.cap,
            }));
            runtime.lastTaskToolUseTurn = runtime.currentTurn;
          }
        }
      }
      return {};
    }

    const tasks = runtime.store.list();
    if (tasks.length === 0) return {};

    const meta = runtime.continuationCooldown.recordFire();
    runtime.lastTaskToolUseTurn = runtime.currentTurn;
    console.warn("[panda-warn]", JSON.stringify({
      code: "subagent.continuation.reminder",
      ts: Date.now(),
      attempt: meta.attempt,
      intervalMs: meta.intervalMs,
    }));
    // Queue the reminder for transient delivery via the `context` hook below.
    // We deliberately do NOT append it to this tool result: doing so persists a
    // now-stale <system-reminder> into session history (it reappears on every
    // later turn) and misattributes host policy text as unrelated tool output.
    // tool_result is used only to track cadence. (Ported from upstream 0.7.0.)
    runtime.reminderDue = true;
    return {};
  });

  // Inject the queued system-reminder as a transient user message before the
  // next LLM call. `context` returns a transformed messages array used only for
  // this one request, so the reminder is never persisted and cannot go stale.
  // One-shot: the flag is cleared as soon as it is drained.
  pi.on("context", async (event) => {
    if (!runtime.reminderDue) return {};
    runtime.reminderDue = false;
    return {
      messages: [
        ...event.messages,
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: SYSTEM_REMINDER }],
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    runtime.latestCtx = ctx;
    runtime.widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(runtime, ctx);
    showPersistedTasks(runtime);
    if (runtime.pendingWarning) {
      ctx.ui.notify(runtime.pendingWarning, "warning");
      runtime.pendingWarning = undefined;
    }
  });

  pi.on("session_switch" as any, async (event: any, ctx: ExtensionContext) => {
    runtime.latestCtx = ctx;
    runtime.widget.setUICtx(ctx.ui as UICtx);

    const isResume = event?.reason === "resume";
    runtime.storeUpgraded = false;
    runtime.persistedTasksShown = false;
    runtime.currentTurn = 0;
    runtime.lastTaskToolUseTurn = 0;
    runtime.continuationCooldown.recordProgress();
    runtime.reminderDue = false;
    runtime.autoClear.reset();

    if (!isResume && runtime.taskScope === "memory") {
      runtime.store.clearAll();
    }

    upgradeStoreIfNeeded(runtime, ctx);
    showPersistedTasks(runtime, isResume);
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    runtime.latestCtx = ctx;
    runtime.widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(runtime, ctx);
    runtime.widget.update();
  });
}
