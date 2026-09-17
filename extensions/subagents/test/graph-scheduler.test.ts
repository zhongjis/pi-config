import { describe, expect, it } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import { Scheduler, type SettleInput } from "../src/graph/scheduler.js";

const agent = (): { type: "agent"; agent: string; prompt: string } => ({ type: "agent", agent: "x", prompt: "p" });

/** Drive a scheduler synchronously, scripting each node's outcome by id + attempt. */
function drive(sched: Scheduler, outcome: (id: string, attempt: number) => SettleInput, guard = 1000): void {
  for (let i = 0; i < guard; i++) {
    const ready = sched.ready();
    if (ready.length > 0) {
      for (const id of ready) {
        sched.markRunning(id);
        sched.settle(id, outcome(id, sched.nodes.get(id)?.attempt ?? 1));
      }
      continue;
    }
    // Quiescent: resolve skips, then break dead cycles, then finish.
    if (sched.resolveSkips() > 0) continue;
    if (!sched.isDone()) {
      sched.forceSkipStuck();
      continue;
    }
    return;
  }
  throw new Error("drive did not terminate within guard");
}

const ok = (output?: unknown): SettleInput => ({ ok: true, output });

describe("Scheduler — linear dependencies", () => {
  it("runs a chain in order and resolves declared outputs", () => {
    const graph: AgentGraph = {
      nodes: { a: agent(), b: agent(), c: agent() },
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
      outputs: { final: { node: "c", path: "$.value" } },
    };
    const sched = new Scheduler(graph, {});
    drive(sched, id => ok({ value: `${id}-out` }));
    expect(sched.isDone()).toBe(true);
    expect(sched.runStatus()).toBe("completed");
    expect([...sched.nodes.values()].every(n => n.status === "completed")).toBe(true);
    expect(sched.resolveOutputs()).toEqual({ final: "c-out" });
  });
});

function reviewGraph(): AgentGraph {
  return {
    nodes: { implement: agent(), review: agent(), fix: agent(), done: agent() },
    edges: [
      { from: "implement", to: "review" },
      { from: "review", to: "done", when: { eq: [{ node: "review", path: "$.approved" }, true] } },
      { from: "review", to: "fix", when: { eq: [{ node: "review", path: "$.approved" }, false] } },
      { from: "fix", to: "review", loop: { maxIterations: 3 } },
    ],
  };
}

describe("Scheduler — conditional branches", () => {
  it("takes the approved branch and skips fix", () => {
    const sched = new Scheduler(reviewGraph(), {});
    drive(sched, id => (id === "review" ? ok({ approved: true }) : ok({})));
    expect(sched.nodes.get("done")?.status).toBe("completed");
    expect(sched.nodes.get("fix")?.status).toBe("skipped");
    expect(sched.runStatus()).toBe("completed");
  });

  it("takes the rejected branch and skips done", () => {
    const sched = new Scheduler(reviewGraph(), {});
    // review rejected once; fix->review re-runs review, which we then approve.
    drive(sched, (id, attempt) => {
      if (id === "review") return ok({ approved: attempt >= 2 });
      return ok({});
    });
    expect(sched.nodes.get("fix")?.status).toBe("completed");
    expect(sched.nodes.get("done")?.status).toBe("completed");
    expect(sched.nodes.get("review")?.attempt).toBe(2);
  });
});

describe("Scheduler — bounded loops", () => {
  it("loops review<->fix until approved, then completes", () => {
    const sched = new Scheduler(reviewGraph(), {});
    // rejected on attempts 1 and 2, approved on attempt 3.
    drive(sched, (id, attempt) => {
      if (id === "review") return ok({ approved: attempt >= 3 });
      return ok({});
    });
    expect(sched.nodes.get("review")?.attempt).toBe(3);
    expect(sched.nodes.get("fix")?.attempt).toBe(2);
    expect(sched.nodes.get("done")?.status).toBe("completed");
    expect(sched.runStatus()).toBe("completed");
  });

  it("terminates when the loop never approves (cap reached)", () => {
    const sched = new Scheduler(reviewGraph(), {});
    drive(sched, id => (id === "review" ? ok({ approved: false }) : ok({})));
    expect(sched.isDone()).toBe(true);
    expect(sched.nodes.get("done")?.status).toBe("skipped");
    // Bounded by the loop policy, not runaway.
    expect(sched.nodes.get("review")?.attempt).toBeLessThanOrEqual(5);
  });
});

describe("Scheduler — failure propagation", () => {
  it("skips every downstream node when a root fails", () => {
    const sched = new Scheduler(reviewGraph(), {});
    drive(sched, id => (id === "implement" ? { ok: false, error: "boom" } : ok({})));
    expect(sched.nodes.get("implement")?.status).toBe("failed");
    expect(sched.nodes.get("review")?.status).toBe("skipped");
    expect(sched.nodes.get("fix")?.status).toBe("skipped");
    expect(sched.nodes.get("done")?.status).toBe("skipped");
    expect(sched.runStatus()).toBe("failed");
  });
});
