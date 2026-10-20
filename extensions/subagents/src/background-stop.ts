import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { GraphRun } from "./graph/history-view.js";
import type { GraphRunTask } from "./graph/task.js";
import type { AgentRecord } from "./types.js";

/** How long after an Esc-aborted run a second Esc stops background work. */
export const BACKGROUND_STOP_WINDOW_MS = 3000;

export interface BackgroundStopDeps {
  listAgents(): AgentRecord[];
  abortAgent(id: string): void;
  graphRuns(): Iterable<GraphRun>;
  now?: () => number;
}

export interface BackgroundStopUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined): () => void;
}

/**
 * Second Esc: after an Esc-aborted run, one more Esc within the window stops the
 * orchestrator's background agents and agent graph runs as an explicit user stop.
 * Outside the window Esc is left to Pi (double-Esc `/tree`).
 */
export function createBackgroundStop(deps: BackgroundStopDeps) {
  const now = deps.now ?? Date.now;
  let armedUntil = 0;

  function running() {
    // Graph-owned and nested children stop with their owner.
    const agents = deps.listAgents().filter(r => r.graphRunId === undefined && r.parentAgentId === undefined
      && (r.status === "running" || r.status === "queued"));
    const graphs = [...deps.graphRuns()].filter((run): run is GraphRunTask => run.type === "local_graph_run"
      && run.status === "running" && !run.abortController.signal.aborted);
    return { agents, graphs };
  }

  function describe(agents: number, graphs: number): string {
    return [
      agents > 0 ? `${agents} background agent${agents === 1 ? "" : "s"}` : "",
      graphs > 0 ? `${graphs} agent graph run${graphs === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(" and ");
  }

  return {
    /** Call when a run settles aborted; arms the window only while background work runs. */
    arm(ui: Pick<BackgroundStopUI, "notify">): void {
      const { agents, graphs } = running();
      if (agents.length + graphs.length === 0) return;
      armedUntil = now() + BACKGROUND_STOP_WINDOW_MS;
      ui.notify(`Press Esc again to stop ${describe(agents.length, graphs.length)}.`, "warning");
    },
    disarm(): void {
      armedUntil = 0;
    },
    /** Subscribe the second-Esc handler; returns the unsubscribe. */
    listen(ui: BackgroundStopUI, isIdle: () => boolean): () => void {
      return ui.onTerminalInput(data => {
        if (armedUntil === 0 || isKeyRelease(data) || !matchesKey(data, "escape")) return undefined;
        const expired = now() > armedUntil;
        armedUntil = 0;
        if (expired || !isIdle()) return undefined;
        const { agents, graphs } = running();
        if (agents.length + graphs.length === 0) return undefined;
        for (const agent of agents) deps.abortAgent(agent.id);
        for (const task of graphs) task.abortController.abort("user");
        ui.notify(`Stopped ${describe(agents.length, graphs.length)}.`, "info");
        return { consume: true };
      });
    },
  };
}
