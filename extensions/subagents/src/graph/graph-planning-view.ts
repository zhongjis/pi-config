import { canMaterialize, isDone, type PlanningView, readyNodes, resolveOutputs, runStatus } from "./graph-planner.js";
import { applyProjection, type ProjectionIntent, ProjectionTable, parseProjection, snapshotProjection } from "./graph-projection.js";
import type { AgentGraph } from "./ir.js";
import type { SchedulerState } from "./scheduler.js";

/** Root-owned projection and read-through planner facade, never lifecycle authority. */
export class GraphProjection {
  readonly state: SchedulerState;
  // Transient insertion-order indexes preserve dynamic numeric bindings; statuses live only in state.
  private readonly nodeOrder: Set<string>;
  private readonly collectionOrder: Set<string>;
  readonly nodes;
  readonly collections;
  constructor(readonly graph: AgentGraph, readonly input: unknown, saved?: SchedulerState) {
    this.state = parseProjection(graph, saved);
    this.nodeOrder = new Set(Object.keys(this.state.nodes));
    this.collectionOrder = new Set(Object.keys(this.state.collections ?? {}));
    this.nodes = new ProjectionTable(() => this.state.nodes, () => this.nodeOrder);
    this.collections = new ProjectionTable(() => this.state.collections ?? {}, () => this.collectionOrder);
  }
  apply(intent: ProjectionIntent): void {
    applyProjection(this.state, intent);
    switch (intent.kind) {
      case "materialize": for (const id of intent.ids) this.nodeOrder.add(id); break;
      case "collection": this.collectionOrder.add(intent.id); break;
      case "start": case "retry": case "settle": case "skips": case "collections": case "restore": break;
      default: { const exhaustive: never = intent; throw new TypeError(`Unknown projection intent: ${exhaustive}`); }
    }
  }
  view(): PlanningView { return { state: this.state, graph: this.graph, input: this.input, nodeOrder: this.nodeOrder, collectionOrder: this.collectionOrder }; }
  nodeIds(): Set<string> { return new Set(this.nodes.keys()); }
  ready(): string[] { return readyNodes(this.view()); }
  canMaterialize(count: number): boolean { return canMaterialize(this.view(), count); }
  isDone(): boolean { return isDone(this.state); }
  runStatus(handled?: ReadonlySet<string>): "completed" | "failed" { return runStatus(this.state, handled); }
  resolveOutputs(): Record<string, unknown> { return resolveOutputs(this.view()); }
  snapshotState(): SchedulerState { return snapshotProjection(this.state); }
}
