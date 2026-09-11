import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGoalForContext } from "../../../goal/src/goal/context.js";
import type { TaskStore } from "../task-store.js";
import type { Task } from "../types.js";

type Runtime = { store: TaskStore; taskScope: string; piTasks: string | undefined };
type Episode = {
  sessionId: string;
  highest: Map<string, number>;
  progress: number;
  progressAtNudge: number;
  nudges: number;
  stopped: boolean;
};
type Run = { episode: Episode; clean: boolean; suppressed: boolean; claimed: boolean };

const STATUS_RANK = { pending: 0, in_progress: 1, completed: 2 };
const MAX_NUDGE_TASKS = 10;
const MAX_SUBJECT_LENGTH = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function eligible(task: Task): boolean {
  return !task.owner && task.metadata._piWorkflowPhase !== "planning" && task.metadata._piOriginMode !== "fuxi";
}

function waiting(ctx: ExtensionContext): boolean {
  if (/<active_agent\s+name\s*=/.test(ctx.getSystemPrompt())) return true;
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== "agent-mode") continue;
    const data: unknown = entry.data;
    if (!isRecord(data)) return true;
    return data.mode === "fuxi" || Boolean(data.planReviewPending) ||
      (isRecord(data.awaitingUserAction) && data.awaitingUserAction.suppressContinuationReminder === true);
  }
  return false;
}

function workersRunning(): boolean {
  const manager: unknown = Reflect.get(globalThis, Symbol.for("pi-subagents:manager"));
  if (manager === undefined) return false;
  if (!isRecord(manager) || typeof manager.hasRunning !== "function") return true;
  return manager.hasRunning() !== false;
}

/** Bounded finish nudges; deliberately independent of the tool-activity reminder cooldown. */
export function registerFinishContinuation(
  pi: Pick<ExtensionAPI, "on" | "events" | "sendMessage">,
  runtime: Runtime,
  readGoal = readGoalForContext,
): void {
  let episode: Episode | undefined;
  let run: Run | undefined;
  let unsubscribe: (() => void) | undefined;

  function invalidate() {
    episode = undefined;
    run = undefined;
  }
  function listen() {
    unsubscribe ??= pi.events.on("user-prompted", () => {
      if (run) run.suppressed = true;
    });
  }

  function allowed(candidate: Run, ctx: ExtensionContext): boolean {
    try {
      return run === candidate && episode === candidate.episode && !candidate.episode.stopped &&
        candidate.episode.sessionId === ctx.sessionManager.getSessionId() &&
        !candidate.suppressed && ctx.isIdle() && !ctx.hasPendingMessages() &&
        (runtime.piTasks === "off" || (!runtime.piTasks && ["session", "memory"].includes(runtime.taskScope))) &&
        !waiting(ctx) && !workersRunning();
    } catch {
      // Any stale context or failed wait-state accessor leaves authority unknown; deliberately fail closed.
      return false;
    }
  }

  function observe(current: Episode): Task[] {
    const tasks = runtime.store.list().filter(task => current.highest.has(task.id) && eligible(task));
    for (const task of tasks) {
      const rank = STATUS_RANK[task.status];
      const previous = current.highest.get(task.id);
      if (previous !== undefined && rank > previous) {
        current.progress++;
        current.highest.set(task.id, rank);
      }
    }
    return tasks.filter(task => task.status !== "completed");
  }

  pi.on("session_start", () => { invalidate(); listen(); });
  pi.on("session_before_switch", invalidate);
  pi.on("session_before_fork", invalidate);
  pi.on("session_before_tree", invalidate);
  pi.on("session_tree", invalidate);
  pi.on("session_shutdown", () => {
    invalidate();
    unsubscribe?.();
    unsubscribe = undefined;
  });
  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return;
    invalidate();
    episode = { sessionId: ctx.sessionManager.getSessionId(), highest: new Map(),
      progress: 0, progressAtNudge: 0, nudges: 0, stopped: false };
  });
  pi.on("agent_start", (_event, ctx) => {
    run = episode?.sessionId === ctx.sessionManager.getSessionId()
      ? { episode, clean: false, suppressed: false, claimed: false } : undefined;
  });
  pi.on("tool_execution_start", (event) => {
    // ponytail: no authoritative live process wait state; suppress this whole run until one exists.
    if (run && (event.toolName === "process" || event.toolName === "interactive_shell")) run.suppressed = true;
  });
  pi.on("tool_result", (event) => {
    if (!run || run.episode !== episode || event.toolName !== "Task" || event.isError) return;
    if (event.input.op !== "create" && event.input.op !== "update") return;
    const details: unknown = event.details;
    if (!isRecord(details) || !Array.isArray(details.taskIds)) return;
    for (const id of details.taskIds) {
      if (typeof id !== "string") continue;
      const task = runtime.store.get(id);
      if (task && eligible(task) && !episode.highest.has(id)) episode.highest.set(id, STATUS_RANK[task.status]);
    }
    observe(episode);
  });
  pi.on("agent_end", (event) => {
    if (!run) return;
    const assistants = event.messages.filter(message => message.role === "assistant");
    run.clean = assistants.length > 0 && assistants.every(message =>
      message.stopReason !== "aborted" && message.stopReason !== "error") &&
      assistants.at(-1)?.stopReason === "stop";
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const candidate = run;
    if (!candidate || candidate.claimed || !candidate.clean) return;
    candidate.claimed = true;
    if (!allowed(candidate, ctx)) return;
    const store = runtime.store;
    try {
      if (await readGoal(ctx)) return;
    } catch {
      // All path, I/O, and parse failures leave Goal authority unknown; deliberately suppress rather than interrupt settlement.
      return;
    }
    if (!allowed(candidate, ctx) || runtime.store !== store) return;
    const current = candidate.episode;
    const tasks = observe(current);
    if (tasks.length === 0) return;
    const taskIds = tasks.map(task => task.id);
    if (current.nudges >= 2 || (current.nudges > 0 && current.progress === current.progressAtNudge)) {
      current.stopped = true;
      pi.sendMessage({ customType: "tasks-finish-unresolved", display: true,
        content: `Task continuation stopped with unresolved tasks: ${taskIds.map(id => `#${id}`).join(", ")}.`,
        details: { taskIds } });
      return;
    }
    current.nudges++;
    current.progressAtNudge = current.progress;
    const summary = tasks.slice(0, MAX_NUDGE_TASKS).map(task =>
      `#${task.id} [${task.status}] ${Array.from(task.subject.replace(/\s+/g, " ")).slice(0, MAX_SUBJECT_LENGTH).join("")}`);
    const remaining = tasks.length > MAX_NUDGE_TASKS ? `\n${tasks.length - MAX_NUDGE_TASKS} more enrolled tasks; inspect with Task before acting.` : "";
    pi.sendMessage({ customType: "tasks-finish-continuation", display: false,
      content: `Unfinished tasks from this user request:\n${summary.join("\n")}${remaining}\nContinue only authorized, actionable work in dependency order; NEVER bypass unfinished blockers. You MUST run the required verification and confirm it passes before marking a task completed. Respect user stops, questions, approval boundaries, and worker waits. If blocked, report the blocker; NEVER complete or delete tasks merely to silence this nudge.`,
      details: { taskIds } }, { triggerTurn: true, deliverAs: "followUp" });
  });
}
