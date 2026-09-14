import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runWorkflow, type WorkflowHost, type WorkflowSpawnRequest, type WorkflowSpawnResult } from "../src/workflow/runtime.js";

const skill = readFileSync(new URL("../skills/subagent-workflows/SKILL.md", import.meta.url), "utf8");
const scripts = [...skill.matchAll(/^```js\n([\s\S]*?)^```/gm)].map(match => match[1]);
function script(index: number): string {
  const source = scripts[index];
  assert.ok(source);
  return source;
}
function host(reply: (request: WorkflowSpawnRequest) => WorkflowSpawnResult, gatePasses = true): WorkflowHost {
  return {
    spawnAgent: async request => reply(request),
    abortAgent() {},
    runGate: async () => ({ ok: gatePasses, output: gatePasses ? "pass" : "check failed" }),
  };
}

describe("complete workflow skill examples", () => {
  it.each([true, false])("retains falsy evidence and identifies a missing required=%s item", async required => {
    const values = [false, 0, ""];
    const calls: string[] = [];
    const result = await runWorkflow({
      script: script(0),
      args: { items: [...values.map((_, index) => ({ id: String(index), path: `source-${index}`, required: true })), { id: "missing", path: "missing", required }] },
      host: host(request => {
        calls.push(request.label);
        if (request.label === "read:missing") return { ok: false, error: "unavailable" };
        return { ok: true, text: JSON.stringify(request.label.startsWith("read:")
          ? { value: values[Number(request.label.split(":")[1])], evidence: "source:1" }
          : { supported: true, evidence: "independently checked source:1" }) };
      }),
    });
    expect(result.status).toBe("completed");
    expect(result.value).toMatchObject({ accepted: !required, attempted: 4, successful: 3, missing: ["missing"],
      items: [...values.map(value => ({ result: { value } })), { id: "missing", result: null }] });
    expect(calls).not.toContain("verify:missing");
  });

  it("does not accept a failed evidence verifier", async () => {
    const result = await runWorkflow({ script: script(0), args: { items: [{ id: "one", path: "README.md", required: true }] },
      host: host(request => request.label.startsWith("read:")
        ? { ok: true, text: JSON.stringify({ value: false, evidence: "source:1" }) }
        : { ok: false, error: "verifier unavailable" }),
    });
    expect(result.status).toBe("completed");
    expect(result.value).toMatchObject({ accepted: false, successful: 0, missing: ["one"] });
  });

  it.each([
    { repair: true, gate: true, calls: 2, accepted: true, reason: "acceptance command passed" },
    { repair: true, gate: false, calls: 4, accepted: false, reason: "attempt limit: verification failed or missing" },
    { repair: false, gate: true, calls: 1, accepted: false, reason: "missing required repair result" },
  ])("bounds repair calls: $reason", async scenario => {
    const calls: WorkflowSpawnRequest[] = [];
    const args = { task: "Fix fixture only", check: "fixture-check" };
    const result = await runWorkflow({ script: script(1), args,
      host: host(request => {
        calls.push(request);
        return scenario.repair ? { ok: true, text: "" } : { ok: false, error: "missing repair" };
      }, scenario.gate),
    });
    expect(result.status).toBe("completed");
    expect(result.value).toMatchObject({ accepted: scenario.accepted, reason: scenario.reason });
    expect(calls).toHaveLength(scenario.calls);
    for (const request of calls.filter(call => call.label.startsWith("repair:"))) {
      expect(request.prompt).toContain(args.task);
      expect(request.prompt).toContain(args.check);
    }
  });

  it.each([0, 1])("rejects missing required args before spawning example %s", async index => {
    let calls = 0;
    const result = await runWorkflow({ script: script(index), host: host(() => { calls++; return { ok: true, text: "" }; }) });
    expect(result.status).toBe("failed");
    expect(calls).toBe(0);
  });
});
