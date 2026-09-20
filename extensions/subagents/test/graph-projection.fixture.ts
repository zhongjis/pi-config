import { type PlanningView, restoreProposal, skipProposal, transitionProposal } from "../src/graph/graph-planner.js";
import { GraphProjection } from "../src/graph/graph-planning-view.js";
import { applyProjection, parseProjection } from "../src/graph/graph-projection.js";
import type { AgentGraph } from "../src/graph/ir.js";
import type { SchedulerState, SettleInput } from "../src/graph/scheduler.js";

/** Scripted root transactions for the existing scheduler behavior corpus. */
export class ProjectionDriver extends GraphProjection {
  constructor(graph: AgentGraph, input: unknown, private readonly maxTotalRuns = 1000) { super(graph, input); }
  override view(): PlanningView { return { ...super.view(), maxTotalRuns: this.maxTotalRuns }; }
  markRunning(id: string): void { applyProjection(this.state, transitionProposal(this.view(), { kind: "start", id })); }
  settle(id: string, result: SettleInput): void { applyProjection(this.state, transitionProposal(this.view(), { kind: "settle", id, result })); }
  retry(id: string): void { applyProjection(this.state, transitionProposal(this.view(), { kind: "retry", id })); }
  resolveSkips(): string[] { return this.skips(false); }
  forceSkipStuck(): string[] { return this.skips(true); }
  private skips(stuck: boolean): string[] {
    const intent = skipProposal(this.view(), stuck);
    applyProjection(this.state, intent);
    return [...intent.skipped];
  }
  hydrate(saved: SchedulerState): void {
    const parsed = parseProjection(this.graph, saved);
    applyProjection(parsed, restoreProposal(parsed));
    Object.assign(this.state, parsed);
  }
}
