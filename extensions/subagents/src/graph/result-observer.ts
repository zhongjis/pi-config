import type { GateRequest } from "./gate-handoff.js";
import { graphRunResultText, type GraphRunTask } from "./task.js";

/** Runtime-owned observation; cancelling a subscriber never cancels execution. */
export function createGraphResultObserver(lookup: (id: string) => GraphRunTask | undefined, gate: (id: string) => GateRequest | undefined, observed: (id: string, gate: GateRequest) => void, collected: (id: string) => void) {
  const listeners = new Map<string, Set<() => void>>();
  const terminal = (task: GraphRunTask) => task.status !== "running" && task.status !== "paused";
  function changed(id: string): void {
    for (const notify of [...(listeners.get(id) ?? [])]) notify();
  }
  async function retrieve(id: string, wait: boolean, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const task = lookup(id);
    if (!task) throw new Error(`Graph run not found: "${id}".`);
    if (wait && !terminal(task) && !gate(id)) await new Promise<void>((resolve, reject) => {
      const subscribers = listeners.get(id) ?? new Set<() => void>();
      listeners.set(id, subscribers);
      const cleanup = () => {
        subscribers.delete(check);
        if (!subscribers.size) listeners.delete(id);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => { cleanup(); reject(signal?.reason); };
      const check = () => {
        if (lookup(id) !== task || terminal(task) || gate(id)) { cleanup(); resolve(); }
      };
      subscribers.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else check();
    });
    if (lookup(id) !== task) throw new Error(`Graph run no longer available: "${id}".`);
    if (terminal(task)) collected(id);
    const request = gate(id);
    if (request) observed(id, request);
    const details = { kind: "graph" as const, taskId: id, run_id: id, status: task.status, gate: request, output: task.value, outcome: task.outcome, error: task.error };
    return {
      content: [{ type: "text" as const, text: `Graph: ${id}\nExecution: ${task.status}\n${task.outcome ? `Outcome: ${JSON.stringify(task.outcome)}\n` : ""}\n${request ? `Human input required. Use ask, then resolve_agent_graph_gate with run_id, gate_id, revision and response.\n${JSON.stringify(request)}` : graphRunResultText(task)}` }],
      details,
    };
  }
  return { changed, retrieve };
}
