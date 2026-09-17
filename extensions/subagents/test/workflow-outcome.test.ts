import { describe, expect, it } from "vitest";
import { workflowEntryData } from "../src/graph/entry.js";
import { isWorkflowEntryData } from "../src/graph/entry-validation.js";
import { runWorkflow, type WorkflowHost } from "../src/graph/runtime.js";
import { completeWorkflowTask, createWorkflowTask, formatWorkflowNotification, updateWorkflowProgressBatch } from "../src/graph/task.js";

const head = 'export const meta = { name: "contract", description: "fixture" };\n';
const host: WorkflowHost = { spawnAgent: async () => ({ ok: false, error: "provider unavailable" }), abortAgent() {} };
const run = (body: string, overrides: Partial<WorkflowHost> = {}) => runWorkflow({ script: head + body, host: { ...host, ...overrides } });

describe("workflow failure/outcome contract", () => {
  it("rejects required failures before dependent work", async () => {
    const calls: string[] = [];
    const result = await run('await agent("required"); await agent("dependent");', {
      spawnAgent: async request => { calls.push(request.prompt); return { ok: false, error: "provider unavailable" }; },
    });
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("provider unavailable") });
    expect(calls).toEqual(["required"]);
  });

  it("short-circuits optional null, not falsy stage results", async () => {
    const result = await run(`const seen = [];
      const values = await pipeline([false, 0, "", "missing"],
        v => v === "missing" ? agent("optional", { optional: true }) : v,
        v => { seen.push(v); return v; });
      return { values, seen };`);
    expect(result).toMatchObject({ status: "completed", value: { values: [false, 0, "", null], seen: [false, 0, ""] } });
  });

  it.each(['parallel([() => { throw new Error("bug"); }])', 'pipeline([1], () => { throw new Error("bug"); })'])("does not swallow programming errors: %s", async expression => {
    expect(await run(`return await ${expression};`)).toMatchObject({ status: "failed", error: "bug" });
  });

  it.each(['{ optional: "yes" }', '{ optional: true, typo: true }', '{ optional: true, schema: {type:"array"} }'])("does not hide invalid configuration: %s", async options => {
    expect(await run(`return await agent("bad", ${options});`)).toMatchObject({ status: "failed" });
  });

  it("does not convert unexpected host exceptions to optional null", async () => {
    expect(await run('return await agent("bad", { optional: true });', { spawnAgent: async () => { throw new TypeError("host bug"); } })).toMatchObject({ status: "failed", error: expect.stringContaining("host bug") });
  });

  it.each([false, 0, "", null])("preserves explicit successful payload %j", async value => {
    expect(await run(`return outcome.succeed(${JSON.stringify(value)});`)).toMatchObject({ status: "completed", outcome: { status: "succeeded" }, value });
  });

  it("preserves omitted payload and shallow freezing", async () => {
    const result = await run(`const payload = { n: 1 }; const wrapped = outcome.succeed(payload);
      if (!Object.isFrozen(outcome) || !Object.isFrozen(wrapped) || Object.isFrozen(payload)) throw new Error("freeze contract");
      payload.n = 2;
      if (wrapped.value.n !== 2) throw new Error("payload copied");
      return outcome.succeed();`);
    expect(result).toMatchObject({ status: "completed", outcome: { status: "succeeded" } });
    expect(result.value).toBeUndefined();
  });

  it.each(["fail", "partial"])("rejects blank %s reasons", async method => {
    expect(await run(`return outcome.${method}("   ", false);`)).toMatchObject({ status: "failed", error: expect.stringContaining("reason") });
  });

  it("rejects malformed reserved envelopes but never infers domain fields", async () => {
    expect(await run('return { $subagentWorkflowOutcome: { status: "failed", reason: " " }, value: 0 };')).toMatchObject({ status: "failed" });
    const legacy = await run('return { accepted: false };');
    expect(legacy).toMatchObject({ status: "completed", value: { accepted: false } });
    expect(legacy).not.toHaveProperty("outcome");
  });

  it("propagates nested outcome envelopes without hiding them", async () => {
    const result = await run('const child = await workflow("child"); if (child.$subagentWorkflowOutcome.status !== "failed") throw new Error("lost outcome"); return child;', {
      loadWorkflow: async () => ({ ok: true, script: head + 'return outcome.fail("verification failed", 0);' }),
    });
    expect(result).toMatchObject({ status: "completed", outcome: { status: "failed", reason: "verification failed" }, value: 0 });
  });

  it("retains outcome through task/snapshot and truthful model notification", async () => {
    const result = await run('await agent("evidence"); return outcome.fail("verification failed", {accepted:false});', { spawnAgent: async () => ({ ok: true, text: "evidence" }) });
    const task = createWorkflowTask({ id: "wf_test", script: head });
    updateWorkflowProgressBatch(task, result.progress);
    completeWorkflowTask(task, result);
    const entry = JSON.parse(JSON.stringify(workflowEntryData(task)));
    expect(entry).toMatchObject({ status: "completed", outcome: { status: "failed", reason: "verification failed" }, value: { accepted: false } });
    expect(isWorkflowEntryData(entry)).toBe(true);
    expect(isWorkflowEntryData({ ...entry, outcome: { status: "failed", reason: " " } })).toBe(false);
    delete entry.outcome;
    expect(isWorkflowEntryData(entry)).toBe(true);
    const text = formatWorkflowNotification(task);
    expect(text).toContain("Outcome failed: verification failed");
    expect(text).toContain("Execution: completed");
    expect(text).toContain("1/1 agents completed");
    expect(text).not.toContain("<status>Done</status>");
  });
});

it.each([false, true])("handles gate and schema failures with optional=%s", async optional => {
  const gate = await run(`await agent('check', {gate:'check', optional:${optional}}); return 'continued';`, {
    spawnAgent: async () => ({ ok: true, text: "done" }), runGate: async () => ({ ok: false, output: "gate evidence" }),
  });
  expect(gate.status).toBe(optional ? "completed" : "failed");
  if (!optional) expect(gate.error).toContain("gate evidence");
  const schema = await run(`return await agent('check', {schema:{type:'object'}, optional:${optional}});`, {
    spawnAgent: async () => ({ ok: true, text: "not JSON" }),
  });
  expect(schema.status).toBe(optional ? "completed" : "failed");
  if (optional) expect(schema.value).toBeNull();
  else expect(schema.error).toMatch(/JSON|schema/);
});

it("preserves deliberate skip as null and stops its pipeline", async () => {
  const result = await run(`return await pipeline([1], () => agent('skip'), () => { throw new Error('dependent ran'); });`, {
    spawnAgent: async () => ({ ok: false, skipped: true, error: "Skipped by user." }),
  });
  expect(result).toMatchObject({ status: "completed", value: [null] });
});

it("rejects malformed nested outcomes even when the parent would ignore them", async () => {
  expect(await run('await workflow("child"); return 1;', {
    loadWorkflow: async () => ({ ok: true, script: head + 'return {$subagentWorkflowOutcome:{status:"failed"}};' }),
  })).toMatchObject({ status: "failed", error: expect.stringContaining("Malformed") });
});

it("does not hide a gate host programming exception in optional mode", async () => {
  expect(await run('return await agent("check", {gate:"check", optional:true});', {
    spawnAgent: async () => ({ ok: true, text: "done" }), runGate: async () => { throw new TypeError("gate host bug"); },
  })).toMatchObject({ status: "failed", error: expect.stringContaining("gate host bug") });
});
