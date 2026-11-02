import type { GraphRun } from "./graph/history-view.js";
import type { GraphRunTask } from "./graph/task.js";
import type { AgentRecord } from "./types.js";

export interface BackgroundStopDeps {
  listAgents(): AgentRecord[];
  abortAgent(id: string): void;
  graphRuns(): Iterable<GraphRun>;
}

/**
 * One stop for all orchestrator-owned work: when the orchestrator run settles
 * aborted (terminal Esc, or an RPC client's stop such as T3 Code), its
 * background agents and agent graph runs stop as an explicit user stop.
 * Foreground agents already stop through their tool's abort signal.
 */
export function createBackgroundStop(deps: BackgroundStopDeps) {
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
    /** Call when the orchestrator run settles aborted; notifies through `ui` when present. */
    stop(ui?: { notify(message: string, type?: "info" | "warning" | "error"): void }): void {
      const { agents, graphs } = running();
      if (agents.length + graphs.length === 0) return;
      for (const agent of agents) deps.abortAgent(agent.id);
      for (const task of graphs) task.abortController.abort("user");
      ui?.notify(`Stopped ${describe(agents.length, graphs.length)}.`, "info");
    },
  };
}
