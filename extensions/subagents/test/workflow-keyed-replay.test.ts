/**
 * workflow-keyed-replay.test.ts — resume matched by a stable author identity.
 *
 * `agent({ key })` lets a call's recorded result be found across a run that
 * repositions it — the completion-order shuffle a pipeline/parallel run can
 * produce — without weakening the prefix rule. A keyed hit is still a *prefix*
 * hit: the first earlier miss ends replay for everything issued after it, so a
 * key can only change *how* an entry is found, never revive one produced under
 * upstream conditions that no longer hold.
 */

import { describe, expect, it } from "vitest";

import { journalKey, type WorkflowJournalEntry } from "../src/workflow/journal.js";
import { type RunWorkflowOptions, runWorkflow, type WorkflowSpawnRequest, type WorkflowSpawnResult } from "../src/workflow/runtime.js";

const HEAD = 'export const meta = { name: "probe", description: "a probe" };\n';

interface Stub {
  calls: WorkflowSpawnRequest[];
  host: { spawnAgent: (r: WorkflowSpawnRequest) => Promise<WorkflowSpawnResult>; abortAgent: () => void };
}

function stubHost(reply?: (request: WorkflowSpawnRequest) => WorkflowSpawnResult): Stub {
  const calls: WorkflowSpawnRequest[] = [];
  return {
    calls,
    host: {
      async spawnAgent(request) {
        calls.push(request);
        return reply ? reply(request) : { ok: true, text: `live:${request.prompt}` };
      },
      abortAgent() {},
    },
  };
}

function recorder() {
  const entries: WorkflowJournalEntry[] = [];
  return { entries, append: (entry: WorkflowJournalEntry) => entries.push(entry) };
}

/**
 * A host whose per-call resolution is delayed by prompt, so a run's settle
 * order — and therefore the issue order the journal records — is controllable.
 * Used to record a pipeline journal whose layout does NOT match the order a
 * later resume issues its calls.
 */
function delayingHost(delayMs: (prompt: string) => number): Stub {
  const calls: WorkflowSpawnRequest[] = [];
  return {
    calls,
    host: {
      async spawnAgent(request) {
        calls.push(request);
        const ms = delayMs(request.prompt);
        if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
        return { ok: true, text: `live:${request.prompt}` };
      },
      abortAgent() {},
    },
  };
}

const run = (body: string, options: Omit<RunWorkflowOptions, "script">) =>
  runWorkflow({ script: HEAD + body, ...options });

describe("keyed replay", () => {
  it("keyed reuse survives reordering", async () => {
    // The journal filed these two calls in an order that does NOT match the
    // order the resumed script issues them — index 0 holds the second call and
    // index 1 the first. A positional replay would miss both; matching by key
    // finds both.
    const journal: WorkflowJournalEntry[] = [
      { index: 0, key: journalKey({ prompt: "beta" }), ok: true, text: "live:beta", nodeKey: "k2" },
      { index: 1, key: journalKey({ prompt: "alpha" }), ok: true, text: "live:alpha", nodeKey: "k1" },
    ];
    const body =
      'const a = await agent("alpha", { key: "k1" });\n' +
      'const b = await agent("beta", { key: "k2" });\n' +
      'return [a, b];';

    const stub = stubHost();
    const result = await run(body, { host: stub.host, journal: { entries: journal } });

    expect(result.value).toEqual(["live:alpha", "live:beta"]);
    expect(result.replayedCount).toBe(2);
    expect(stub.calls, "a full keyed hit must not reach the host at all").toHaveLength(0);
  });

  it("edit upstream keyed node invalidates downstream tail", async () => {
    // b is issued after a and keeps a key that still matches the journal, but
    // the invariant is that a keyed hit is a *prefix* hit: a's edit breaks the
    // prefix, so b runs live even though its key is right there in the journal.
    const journal: WorkflowJournalEntry[] = [
      { index: 0, key: journalKey({ prompt: "alpha" }), ok: true, text: "live:alpha", nodeKey: "k1" },
      { index: 1, key: journalKey({ prompt: "beta" }), ok: true, text: "live:beta", nodeKey: "k2" },
    ];
    const body =
      'const a = await agent("alpha edited", { key: "k1" });\n' +
      'const b = await agent("beta", { key: "k2" });\n' +
      'return [a, b];';

    const stub = stubHost(() => ({ ok: true, text: "fresh" }));
    const result = await run(body, { host: stub.host, journal: { entries: journal } });

    expect(result.replayedCount).toBe(0);
    expect(stub.calls.map(c => c.prompt)).toEqual(["alpha edited", "beta"]);
  });

  it("unkeyed resume unchanged", async () => {
    // Regression: a resume of an unkeyed script reuses the whole prefix exactly
    // as it did before keys existed.
    const twoAgents = 'const a = await agent("first");\nconst b = await agent("second");\nreturn [a, b];';
    const first = recorder();
    await run(twoAgents, { host: stubHost().host, journal: first });

    const second = stubHost();
    const result = await run(twoAgents, { host: second.host, journal: { entries: first.entries } });

    expect(result.value).toEqual(["live:first", "live:second"]);
    expect(result.replayedCount).toBe(2);
    expect(second.calls).toHaveLength(0);
  });

  it("auto-keyed pipeline survives reordering", async () => {
    // The money test: a two-stage pipeline with NO manual keys. pipeline auto-
    // assigns each child a structural nodeKey, so replay survives a run whose
    // completion order reshuffles the issue order — the exact case a positional-
    // only engine misses.
    const body =
      'return await pipeline(["A", "B"],\n' +
      '  (v) => agent("s1:" + v),\n' +
      '  (v) => agent("s2:" + v));';

    // Phase 1: record. Delay stage-1 for item A so item B reaches stage 2 first,
    // making the recorded issue order [s1:A, s1:B, s2:B, s2:A] — s2:B before s2:A.
    const first = recorder();
    const recording = await run(body, {
      host: delayingHost(prompt => (prompt === "s1:A" ? 40 : 0)).host,
      journal: first,
      concurrency: 4,
    });
    expect(recording.status).toBe("completed");
    // Auto keys are derived from structural position, not settle order.
    expect([...first.entries].map(e => e.nodeKey).sort()).toEqual([
      "pl0.0:a0",
      "pl0.1:a0",
      "pl1.0:a0",
      "pl1.1:a0",
    ]);
    const totalCalls = first.entries.length;
    expect(totalCalls).toBe(4);

    // Phase 2: resume with a host that would settle in array order (A before B),
    // a DIFFERENT order than the journal recorded. Positional matching would
    // miss the stage-2 tail; auto-key matches every call by identity.
    const second = delayingHost(prompt => (prompt === "s2:A" ? 0 : 40));
    const result = await run(body, {
      host: second.host,
      journal: { entries: first.entries },
      concurrency: 4,
    });

    // Stage 2 receives stage 1's result as its input, so the prompts chain.
    expect(result.value).toEqual(["live:s2:live:s1:A", "live:s2:live:s1:B"]);
    expect(result.replayedCount).toBe(totalCalls);
    expect(result.agentCount).toBe(totalCalls);
    expect(second.calls, "auto-keyed reuse must spawn nothing on resume").toHaveLength(0);
  });

  it("auto keys do not collide across items", async () => {
    // Two thunks with the identical prompt: same journalKey, so only a distinct
    // nodeKey per structural position keeps them from claiming each other's cache.
    const body = 'return await parallel([() => agent("x"), () => agent("x")]);';
    const first = recorder();
    await run(body, { host: stubHost().host, journal: first });

    const nodeKeys = first.entries.map(e => e.nodeKey);
    expect(new Set(nodeKeys).size).toBe(2);
    expect([...nodeKeys].sort()).toEqual(["par0:a0", "par1:a0"]);

    const second = stubHost();
    const result = await run(body, { host: second.host, journal: { entries: first.entries } });
    expect(result.replayedCount).toBe(2);
    expect(second.calls, "distinct auto keys must both reuse, none collide").toHaveLength(0);
  });

  it("explicit key overrides auto key", async () => {
    // Inside a pipeline stage, a manual key is the escape hatch and always wins
    // over the structural auto key.
    const body = 'return await pipeline(["A"], (v) => agent("p:" + v, { key: "manual" }));';
    const first = recorder();
    await run(body, { host: stubHost().host, journal: first });

    expect(first.entries).toHaveLength(1);
    expect(first.entries[0].nodeKey).toBe("manual");
  });

  it("top-level agent unchanged", async () => {
    // Regression: a top-level agent() has no pipeline/parallel store on the
    // stack, so it gets no auto key and resumes by position exactly as before.
    const twoAgents = 'const a = await agent("first");\nconst b = await agent("second");\nreturn [a, b];';
    const first = recorder();
    await run(twoAgents, { host: stubHost().host, journal: first });
    expect(first.entries.every(e => e.nodeKey === undefined)).toBe(true);

    const second = stubHost();
    const result = await run(twoAgents, { host: second.host, journal: { entries: first.entries } });
    expect(result.value).toEqual(["live:first", "live:second"]);
    expect(result.replayedCount).toBe(2);
    expect(second.calls).toHaveLength(0);
  });
});
