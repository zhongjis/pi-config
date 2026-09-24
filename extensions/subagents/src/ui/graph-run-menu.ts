/**
 * graph-run-menu.ts — `/agents → Graph runs`, and the run inspector behind it.
 *
 * The same shape `schedule-menu.ts` has for `/agents → Scheduled jobs`: the
 * submenu and the overlay it opens live here, and everything they need arrives
 * as {@link GraphRunMenuDeps} rather than through a closure. The inspector is
 * reached from two places — this menu and a graph run row in the fleet list —
 * and both go through `showGraphRunDialog`, so the two entry points cannot
 * drift apart on what the keys do.
 *
 * Lives in the agents menu, FleetView and the Agent Monitor; `/agent-monitor`
 * is the only top-level monitor command.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GraphRun } from "../graph/history-view.js";
import { pauseGraphRunTask, resumeGraphRunTask } from "../graph/task.js";
import type { AgentRecord } from "../types.js";
import { GraphRunPanelView } from "./graph-run-panel-view.js";

/** Everything the menu and the inspector need from the extension around them. */
export type GraphRunUIContext = Pick<ExtensionContext, "ui">;

export interface GraphRunMenuDeps {
  /**
   * Live runs by id, read on every use rather than snapshotted: a run that
   * settled and was swept between render and keypress must be a no-op, not a
   * crash.
   */
  tasks: ReadonlyMap<string, GraphRun>;
  /** The record behind an agent id, or undefined once it has been swept. */
  getRecord(id: string): AgentRecord | undefined;
  /** The conversation overlay `c` opens on an agent row. */
  viewAgentConversation(ctx: GraphRunUIContext, record: AgentRecord): Promise<void>;
  /**
   * The session context, for the fleet-list entry point — that one is a
   * keypress in a list that holds no `ctx` of its own. Undefined between
   * sessions, which is a no-op rather than an error.
   */
  getCtx(): GraphRunUIContext | undefined;
  /** Detach a graph run to the read-only Herdr side pane; absent without a Herdr-managed pane. */
  detach?: { available(): boolean; open(runId: string): Promise<boolean> };
}

/**
 * Open the inspector for a graph run.
 *
 * All six controls are wired: `onKill` aborts the run's controller, while
 * pause/resume and per-agent skip/retry go through `task.control`, the handle
 * the graph run hands back. `onOpenAgent` is the odd one out — it opens the
 * child's conversation rather than changing the run. The dialog derives its key
 * hints from the actions it is handed, so the footer advertises exactly what
 * works — see `GraphRunDialogActions`.
 */
export async function showGraphRunDialog(
  ctx: GraphRunUIContext,
  task: GraphRun,
  deps: GraphRunMenuDeps,
): Promise<void> {
  // Overlaid on the same terms as the conversation viewer, because they are
  // reached the same way: both are rows of the fleet list, and opening one
  // must not behave unlike opening the other. Inline, the frame would render
  // into the conversation and stay in the scrollback after it closed.
  const { VIEWPORT_HEIGHT_PCT } = await import("./conversation-viewer.js");
  /**
   * This host's own overlay, so `c` (open a node's conversation) can hide it
   * while the viewer is up. Overlays stack, so the viewer would render *over* it
   * either way — but the two frames size themselves to different content, and
   * the taller one's edges show around the shorter. Hidden, there is nothing to
   * peek out, and un-hiding puts the focus back on the panel when the viewer
   * closes.
   */
  let overlay: { setHidden(hidden: boolean): void } | undefined;
  // Re-read on every render: the runs are in the background, so the panel
  // follows them rather than snapshotting at open time. Newest first, as the pane.
  const runs = () => [...deps.tasks.values()].sort((a, b) => b.startTime - a.startTime);
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) =>
      new GraphRunPanelView(tui, runs, task.id, theme, done, {
        controls: true,
        detach: deps.detach?.available() ?? false,
        viewportPct: VIEWPORT_HEIGHT_PCT,
        onAction: (action, run) => {
          // Detach is the only control a history run answers; every other action
          // is a live-run mutation and stays a no-op on read-only history.
          if (run.type === "history") {
            if (action.kind === "detach") {
              void deps.detach?.open(run.id).then(ok => {
                if (!ok) ctx.ui.notify("Detach needs a Herdr-managed pane.", "warning");
              });
            }
            return;
          }
          switch (action.kind) {
            case "kill":
              if (run.abortController.signal.aborted) return;
              run.abortController.abort("user");
              ctx.ui.notify(`Stopped graph run "${run.meta?.name ?? run.id}".`, "info");
              return;
            case "pause":
              // Named rather than implied: "paused" on a run whose agents are
              // still finishing reads as a stronger promise than it is.
              if (pauseGraphRunTask(run)) {
                ctx.ui.notify("Paused — running agents finish, no new ones start.", "info");
              }
              return;
            case "resume":
              if (resumeGraphRunTask(run)) ctx.ui.notify("Resumed.", "info");
              return;
            case "skip":
              if (run.control?.skip(action.index) !== true) {
                ctx.ui.notify("Nothing to skip — that agent has already finished.", "info");
              }
              return;
            case "retry":
              // The window is exactly "while it is running": before that there is
              // nothing to stop, after it the script has its answer.
              if (run.control?.retry(action.index) !== true) {
                ctx.ui.notify("Only a running agent can be retried.", "info");
              }
              return;
            case "open": {
              const record = deps.getRecord(action.recordId);
              // A retained progress row can outlive its child's session.
              if (record === undefined) {
                ctx.ui.notify("Conversation no longer available — this agent record has been cleaned up.", "info");
                return;
              }
              overlay?.setHidden(true);
              // Caught before the `finally`, so a viewer that fails to open still
              // un-hides the host and cannot surface as an unhandled rejection out
              // of a detached promise.
              void deps.viewAgentConversation(ctx, record)
                .catch(err => ctx.ui.notify(
                  `Could not open the conversation: ${err instanceof Error ? err.message : String(err)}`,
                  "warning",
                ))
                .finally(() => overlay?.setHidden(false));
              return;
            }
            case "detach":
              void deps.detach?.open(run.id).then(ok => {
                if (!ok) ctx.ui.notify("Detach needs a Herdr-managed pane.", "warning");
              });
              return;
          }
        },
      }),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      onHandle: handle => { overlay = handle; },
    },
  );
}

/**
 * Open a run from the fleet list.
 *
 * The list hands back an id rather than a task, so a run that settled and was
 * swept between render and keypress is a no-op instead of a crash. `esc` in the
 * dialog closes it and control returns to the list — which is why the promise
 * is handed back: the list puts the cursor back on the run rather than dropping
 * the reader at `main`.
 */
export function openGraphRunFromFleet(id: string, deps: GraphRunMenuDeps): Promise<void> | void {
  const task = deps.tasks.get(id);
  const ctx = deps.getCtx();
  if (task === undefined || ctx === undefined) return;
  return showGraphRunDialog(ctx, task, deps);
}

/** `/agents → Graph runs` — list this session's runs, open one. */
export async function showGraphRunsMenu(
  ctx: GraphRunUIContext,
  deps: GraphRunMenuDeps,
): Promise<void> {
  const tasks = [...deps.tasks.values()].sort((a, b) => b.startTime - a.startTime);
  if (tasks.length === 0) {
    ctx.ui.notify("No graph runs in this session.", "info");
    return;
  }
  if (tasks.length === 1) {
    await showGraphRunDialog(ctx, tasks[0], deps);
    return;
  }
  // More than one: pick first. Newest at the top, since that is almost
  // always the one being asked about. `select` deals in plain strings and
  // hands back the string, so the label has to be unique or `indexOf` maps
  // the second run of a graph onto the first — the run id makes it so.
  const labels = tasks.map(
    task =>
      `${task.meta?.name ?? task.id}${task.type === "history" ? " · History (read-only)" : ""} — Execution: ${task.status}, ${task.agentCount} agent${
        task.agentCount === 1 ? "" : "s"
      } · ${task.id}`,
  );
  const picked = await ctx.ui.select("Graph runs", labels);
  const index = picked !== undefined ? labels.indexOf(picked) : -1;
  if (index >= 0) await showGraphRunDialog(ctx, tasks[index], deps);
}
