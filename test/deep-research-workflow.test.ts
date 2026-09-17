import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { runWorkflow, type WorkflowSpawnRequest, type WorkflowSpawnResult } from "../extensions/subagents/src/graph/runtime.js";
import { resolveWorkflowSource } from "../extensions/subagents/src/graph/saved.js";

const args = { question: "Compare options", requirements: ["A", "B", "C"], readOnlyAgentType: "fixture-reader", evidenceContext: "fixture sources" } as const;
const ok = (value: unknown): WorkflowSpawnResult => ({ ok: true, text: JSON.stringify(value) });
const missing: WorkflowSpawnResult = { ok: false, error: "fixture unavailable" };
type Reply = (request: WorkflowSpawnRequest) => WorkflowSpawnResult | Promise<WorkflowSpawnResult>;
function discovery(requirement: string, followUps: string[] = []) {
  return { evidence: [{ source: `source:${requirement}`, excerpt: `fact:${requirement}` }], claims: [{ requirement, text: `claim:${requirement}`, evidenceIndexes: [0] }], followUps: followUps.map(question => ({ requirement, question })) };
}
function verdict(id: number, requirement: string) {
  return { claimId: `c${id}`, supported: true, evidence: [{ evidenceId: `e${id}`, source: `source:${requirement}`, excerpt: `fact:${requirement}` }], resolves: [], reason: "source inspected" };
}
const happy: Reply = request => {
  if (request.phaseTitle === "Discover") return ok(discovery(args.requirements[Number(request.label.split(":")[1]) - 1] ?? "A"));
  if (request.phaseTitle === "Challenge") return ok({ challenges: [] });
  return ok({ verdicts: [verdict(1, "A"), verdict(2, "B"), verdict(3, "C")] });
};
async function run(reply: Reply = happy, input: unknown = args) {
  const source = resolveWorkflowSource({ scriptPath: "workflows/deep-research.js" }, process.cwd());
  if (source.ok === false) assert.fail(source.message);
  const calls: WorkflowSpawnRequest[] = [];
  let active = 0;
  let peak = 0;
  const result = await runWorkflow({ script: source.script, args: input, concurrency: 8, host: {
    async spawnAgent(request) {
      calls.push(request);
      active++;
      peak = Math.max(peak, active);
      try { return await reply(request); } finally { active--; }
    },
    abortAgent() {},
  } });
  return { result, calls, peak };
}

describe("deep research saved workflow", () => {
  it("core: accepts independently cited complete coverage", async () => {
    const { result, calls } = await run();
    expect(result.status).toBe("completed");
    expect(result.outcome).toEqual({ status: "succeeded" });
    expect(result.value).toMatchObject({ accepted: true, stopReason: "covered", citedFindings: [
      { id: "c1", evidenceIds: ["e1"] }, { id: "c2", evidenceIds: ["e2"] }, { id: "c3", evidenceIds: ["e3"] },
    ], coverage: args.requirements.map(requirement => ({ requirement, verified: true, unresolved: false })), metrics: { rounds: 1, scheduledCalls: 5 } });
    expect(calls.map(call => call.agentType)).toEqual(Array(5).fill("fixture-reader"));
    expect(calls.every(call => call.schema?.schema.type === "object")).toBe(true);
    const discoverySchemas = calls.filter(call => call.phaseTitle === "Discover").map(call => call.schema?.schema);
    expect(discoverySchemas).toHaveLength(3);
    expect(discoverySchemas.every(schema => !JSON.stringify(schema).includes('"uniqueItems"'))).toBe(true);
  });

  it.each([
    null, {}, { ...args, question: " " }, { ...args, requirements: [] }, { ...args, requirements: ["A", "A"] },
    { ...args, requirements: [" "] }, { ...args, requirements: Array.from({ length: 7 }, (_, i) => String(i)) },
    { ...args, readOnlyAgentType: " " }, { ...args, evidenceContext: "" }, { ...args, maxRounds: 0 },
    { ...args, maxRounds: 4 }, { ...args, maxRounds: 1.5 }, { ...args, extra: true },
  ])("core: rejects invalid input before spawning (%j)", async input => {
    let spawned = 0;
    await expect(run(() => { spawned++; return missing; }, input)).rejects.toThrow();
    expect(spawned).toBe(0);
  });

  it("core: rejects normalized duplicate requirements before spawning", async () => {
    const { result, calls } = await run(happy, { ...args, requirements: ["A", " A "] });
    expect(result.status).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it.each(["null", "throw"])("stops dependent analysis on required discovery failure: %s", async failure => {
    const { result, calls } = await run(request => {
      if (request.label === "discover:2") {
        if (failure === "throw") throw new Error("fixture discovery failed");
        return missing;
      }
      return happy(request);
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/fixture/);
    expect(calls.every(call => call.phaseTitle === "Discover")).toBe(true);
  });

  it.each(["Challenge", "Verify"])("stops execution when required %s fails", async phase => {
    const { result, calls } = await run(request => request.phaseTitle === phase ? missing : happy(request));
    expect(result.status).toBe("failed");
    if (phase === "Challenge") expect(calls.some(call => call.phaseTitle === "Verify")).toBe(false);
  });

  it("excludes challenged claims even with favorable votes", async () => {
    const { result } = await run(request => request.phaseTitle === "Challenge"
      ? ok({ challenges: [{ claimId: "c1", reason: "opposing primary evidence" }] }) : happy(request));
    expect(result.value).toMatchObject({ accepted: false, contestedClaims: [{ id: "c1" }], citedFindings: [{ id: "c2" }, { id: "c3" }] });
  });

  it("records rejected claims without treating rejection as missing", async () => {
    const { result } = await run(request => request.phaseTitle === "Verify" ? ok({ verdicts: [{ ...verdict(1, "A"), supported: false, evidence: [] }, verdict(2, "B"), verdict(3, "C")] }) : happy(request));
    expect(result.value).toMatchObject({ accepted: false, rejectedClaims: [{ id: "c1" }], coverage: [{ rejected: ["c1"], missing: [], verified: false }, {}, {}] });
  });

  it("keeps challenged claims in the rejected ledger when verification rejects them", async () => {
    const { result } = await run(request => {
      if (request.phaseTitle === "Challenge") return ok({ challenges: [{ claimId: "c1", reason: "contradictory source" }] });
      if (request.phaseTitle === "Verify") return ok({ verdicts: [{ ...verdict(1, "A"), supported: false, evidence: [] }, verdict(2, "B"), verdict(3, "C")] });
      return happy(request);
    });
    expect(result.value).toMatchObject({ rejectedClaims: [{ id: "c1" }], contestedClaims: [] });
  });

  it.each(["unknown", "foreign", "source"])("rejects invalid verifier citations: %s", async kind => {
    const bad = { ...verdict(1, "A"), evidence: [{ evidenceId: kind === "unknown" ? "e999" : kind === "foreign" ? "e2" : "e1", source: "forged", excerpt: "assertion" }] };
    const { result } = await run(request => request.phaseTitle === "Verify" ? ok({ verdicts: [bad, verdict(2, "B"), verdict(3, "C")] }) : happy(request));
    expect(result.value).toMatchObject({ accepted: false, stopReason: "verification_failed", citedFindings: [{ id: "c2" }, { id: "c3" }] });
    expect(result.outcome).toEqual({ status: "failed", reason: "verification_failed" });
  });

  it("rejects discovery claims with invalid local evidence references", async () => {
    const { result } = await run(request => request.label === "discover:1" ? ok({ ...discovery("A"), claims: [{ requirement: "A", text: "unsupported", evidenceIndexes: [2] }] }) : happy(request));
    expect(result.value).toMatchObject({ accepted: false, rejectedClaims: [{ id: "c1", reason: "invalid_evidence" }], citedFindings: [{ id: "c2" }, { id: "c3" }] });
  });

  it("rejects duplicate local evidence references without provider schema constraints", async () => {
    const { result } = await run(request => request.label === "discover:1" ? ok({ ...discovery("A"), claims: [{ requirement: "A", text: "duplicated", evidenceIndexes: [0, 0] }] }) : happy(request));
    expect(result.value).toMatchObject({ accepted: false, rejectedClaims: [{ id: "c1", reason: "invalid_evidence" }], coverage: [{ missing: [], rejected: ["c1"] }, {}, {}] });
  });

  it("assigns identical IDs and output despite reversed completion", async () => {
    const normal = await run();
    const pending = new Map<string, (value: WorkflowSpawnResult) => void>();
    const reversed = await run(request => {
      if (request.phaseTitle !== "Discover") return happy(request);
      return new Promise(resolve => {
        pending.set(request.label, resolve);
        if (pending.size === 3) for (const label of ["discover:3", "discover:2", "discover:1"]) {
          const finish = pending.get(label);
          assert.ok(finish);
          finish(ok(discovery(args.requirements[Number(label.split(":")[1]) - 1] ?? "A")));
        }
      });
    });
    expect(reversed.result.value).toEqual(normal.result.value);
    expect(reversed.peak).toBe(3);
  });

  it("reports frontier exhaustion with uncovered requirements", async () => {
    const { result } = await run(request => request.phaseTitle === "Discover" ? ok({ evidence: [], claims: [], followUps: [] }) : ok(request.phaseTitle === "Challenge" ? { challenges: [] } : { verdicts: [] }));
    expect(result.value).toMatchObject({ accepted: false, stopReason: "frontier_exhausted", gaps: args.requirements.map(requirement => ({ requirement })) });
  });

  it("converges when new questions add no independent support", async () => {
    const { result, calls } = await run(request => request.phaseTitle === "Discover" ? ok(discovery("A", ["next"])) : ok(request.phaseTitle === "Challenge" ? { challenges: [] } : { verdicts: [] }));
    expect(result.value).toMatchObject({ accepted: false, stopReason: "converged", metrics: { rounds: 1 }, coverage: [{ deferred: ["q4"] }, {}, {}] });
    expect(calls).toHaveLength(5);
  });

  it("bounds rounds, admitted frontier and total scheduled calls", async () => {
    let discovered = 0;
    let round = 0;
    const { result, calls, peak } = await run(request => {
      if (request.phaseTitle === "Discover") {
        discovered++;
        return ok({ ...discovery("R1", [`next-${discovered}-a`, `next-${discovered}-b`, `next-${discovered}-c`]), evidence: [{ source: `source:R${discovered}`, excerpt: `fact:R${discovered}` }] });
      }
      if (request.phaseTitle === "Challenge") return ok({ challenges: [] });
      round++;
      return ok({ verdicts: Array.from({ length: discovered }, (_, i) => verdict(i + 1, `R${i + 1}`)) });
    }, { ...args, requirements: ["R1", "R2", "R3", "R4", "R5", "R6"], maxRounds: 3 });
    expect(result.value).toMatchObject({ accepted: false, stopReason: "round_limit", metrics: { rounds: 3, scheduledCalls: 15, frontierQuestions: 12 } });
    expect(round).toBe(3);
    expect(calls.filter(call => call.phaseTitle === "Challenge").map(call => call.label)).toEqual(["skeptic:1", "skeptic:2", "skeptic:3"]);
    expect(calls.filter(call => call.phaseTitle === "Verify").map(call => call.label)).toEqual(["verifier:1", "verifier:2", "verifier:3"]);
    expect(calls).toHaveLength(15);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("enforces discovery array bounds at the runtime boundary", async () => {
    const { result } = await run(request => request.label === "discover:1" ? ok({ ...discovery("A"), evidence: Array(4).fill({ source: "source:A", excerpt: "fact" }) }) : happy(request));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("schema");
  });

  it("converges when further evidence only repeats an independently checked source", async () => {
    let discovered = 0;
    const { result } = await run(request => {
      if (request.phaseTitle === "Discover") return ok(discovery("A", [`follow-${++discovered}`]));
      if (request.phaseTitle === "Challenge") return ok({ challenges: [] });
      return ok({ verdicts: Array.from({ length: discovered }, (_, index) => verdict(index + 1, "A")) });
    });
    expect(result.value).toMatchObject({ accepted: false, stopReason: "converged", metrics: { rounds: 2, evidenceStrength: 1 } });
  });

  it("accepts a challenged claim only after independent cited resolution", async () => {
    const { result } = await run(request => {
      if (request.phaseTitle === "Challenge") return ok({ challenges: [{ claimId: "c1", reason: "counterevidence" }] });
      if (request.phaseTitle === "Verify") return ok({ verdicts: [{ ...verdict(1, "A"), resolves: ["h1"] }, verdict(2, "B"), verdict(3, "C")] });
      return happy(request);
    });
    expect(result.value).toMatchObject({ accepted: true, contestedClaims: [], challenges: [{ id: "h1", resolved: true }], metrics: { resolvedChallenges: 1 } });
  });

  it("retains rejected history after later coverage succeeds", async () => {
    const { result } = await run(request => {
      if (request.phaseTitle === "Discover") return request.label === "discover:1" ? ok(discovery("A", ["check again"])) : happy(request);
      if (request.label === "verifier:1") return ok({ verdicts: [{ ...verdict(1, "A"), supported: false, evidence: [] }, verdict(2, "B"), verdict(3, "C")] });
      if (request.label === "verifier:2") return ok({ verdicts: [verdict(2, "B"), verdict(3, "C"), verdict(4, "A")] });
      return happy(request);
    });
    expect(result.value).toMatchObject({ accepted: true, stopReason: "covered", rejectedClaims: [{ id: "c1", round: 1 }], coverage: [{ rejected: ["c1"] }, {}, {}] });
  });

  it("honors an explicit one-round cap and preserves deferred requirements", async () => {
    const { result } = await run(happy, { ...args, requirements: ["A", "B", "C", "D"], maxRounds: 1 });
    expect(result.value).toMatchObject({ accepted: false, stopReason: "round_limit", coverage: [{}, {}, {}, { requirement: "D", attempted: [], deferred: ["q4"], verified: false }] });
  });
});
