import { expect, it } from "vitest";
import { createActor, toPromise } from "xstate";
import { graphLogic } from "../src/graph/graph-actor.js";

it.each(["agent", "human_gate"] as const)("dispatches %s through admission and release handshakes", async type => {
  const events: string[] = [];
  const actor = createActor(graphLogic, {
    inspect: event => { if (event.type === "@xstate.event") events.push(event.event.type); },
    input: { graph: { nodes: { a: type === "agent" ? { type, agent: "worker", prompt: "fixture" } : { type, prompt: "fixture", outputSchema: { type: "object" } } }, edges: [] }, input: {}, depth: 0,
      options: { onCheckpoint: () => { events.push("checkpoint"); }, host: {
        spawnAgent: async () => { events.push("effect"); return { ok: true }; },
        awaitHumanGate: async () => { events.push("effect"); return { ok: true, output: "{}" }; },
      } } },
  }).start();
  expect((await toPromise(actor)).status).toBe("completed");
  expect(events).toContain("NODE.ADMITTED");
  expect(events.indexOf("checkpoint")).toBeLessThan(events.indexOf("NODE.ADMITTED"));
  expect(events.indexOf("NODE.ADMITTED")).toBeLessThan(events.indexOf("effect"));
  expect(events.indexOf("NODE.ACK")).toBeLessThan(events.indexOf("NODE.RELEASE_READY"));
  expect(events.indexOf("NODE.RELEASE_READY")).toBeLessThan(events.indexOf("NODE.RELEASE"));
  expect(events.indexOf("NODE.RELEASE")).toBeLessThan(events.indexOf("NODE.RELEASED"));
  expect(events.some(event => event.startsWith("WORK."))).toBe(false);
});

it.each(["gate", "repair"] as const)("ACKs a pending %s after durable global cancellation without another effect", async boundary => {
  const events: string[] = []; let calls = 0; let gates = 0; let cancelled = false;
  const actor = createActor(graphLogic, {
    inspect: event => { if (event.type === "@xstate.event" && event.event.type.startsWith("NODE.")) events.push(event.event.type); },
    input: { graph: { nodes: { a: { type: "agent", agent: "worker", prompt: "fixture", retry: { maxAttempts: 2 }, ...(boundary === "gate" ? { validation: { gate: "check" } } : {}) } }, edges: [] }, input: {}, depth: 0,
      options: { host: { spawnAgent: async () => { calls++; return { ok: boundary === "gate" }; }, runGate: async () => { gates++; return { ok: true, output: "" }; } },
        onCheckpoint: state => {
          const ledger = state.runtime?.executionLedger?.filter(row => "payload" in row) ?? [];
          if (!cancelled && (boundary === "gate" ? ledger.some(row => row.payload.kind === "dispatched" && row.payload.target === "validation-gate") : ledger.filter(row => row.payload.kind === "admitted").length === 2)) {
            cancelled = true; actor.send({ type: "CANCEL", reason: "shutdown" });
          }
        },
      } },
  });
  actor.start(); expect((await toPromise(actor)).status).toBe("aborted");
  expect(calls).toBe(1); expect(gates).toBe(0);
  expect(events.filter(event => event === "NODE.ACK")).toHaveLength(3);
  expect(events.at(-1)).toBe("NODE.RELEASED");
});

it.each(["concurrency", "resource", "replacement"] as const)("retains %s ownership through settlement ACK until release completion", async capacity => {
  const evidence: string[] = []; let calls = 0;
  const worker = { type: "agent" as const, agent: "worker", prompt: "fixture", resources: ["exclusive"] };
  const actor = createActor(graphLogic, {
    inspect: event => {
      if (event.type !== "@xstate.event") return;
      if (["NODE.ACK", "NODE.RELEASE_READY", "NODE.RELEASE", "NODE.RELEASED"].includes(event.event.type)) {
        evidence.push(event.event.type);
        if (calls === 1 || capacity === "replacement") expect(actor.getSnapshot().children["node:a"]).toBeDefined();
      }
    },
    input: { graph: { nodes: capacity === "replacement" ? { a: worker } : { a: worker, b: worker }, edges: [] }, input: {}, depth: 0,
      options: { concurrency: capacity === "concurrency" ? 1 : 2, resources: { exclusive: { capacity: 1 } },
        host: { spawnAgent: async () => { if (++calls === 2) expect(evidence).toContain("NODE.RELEASED"); return { ok: true }; } },
        onCheckpoint: state => {
          if (state.nodes.a.status === "completed" && calls === 1 && !evidence.includes("NODE.RELEASED")) {
            expect(actor.getSnapshot().children["node:a"]).toBeDefined();
            expect(actor.getSnapshot().context.domain?.running()).toContain("a");
          }
        },
        onControl: control => {
          if (capacity !== "replacement") return;
          // Request retry after admission publication but before the deferred first effect.
          actor.subscribe({ next: snapshot => { if (calls === 1 && snapshot.context.domain?.projection.nodes.get("a")?.status === "running" && !evidence.includes("retry")) { evidence.push("retry"); control.retry(0); } }, error: () => {} });
        },
      } },
  });
  actor.start(); expect((await toPromise(actor)).status).toBe("completed");
  expect(calls).toBe(2);
});

it("coalesces pending gate retransmissions before the containing checkpoint ACK", async () => {
  let acks = 0; let gateFrames = 0; let duplicated = false;
  const actor = createActor(graphLogic, {
    inspect: event => { if (event.type === "@xstate.event" && event.event.type === "NODE.ACK") acks++; },
    input: { graph: { nodes: { a: { type: "agent", agent: "worker", prompt: "fixture", validation: { gate: "check" } } }, edges: [] }, input: {}, depth: 0,
      options: { host: { spawnAgent: async () => ({ ok: true }), runGate: async () => ({ ok: true, output: "" }) }, onCheckpoint: state => {
        const last = state.runtime?.executionLedger?.at(-1);
        if (!last || !("payload" in last) || last.payload.kind !== "dispatched" || last.payload.target !== "validation-gate") return;
        gateFrames++;
        if (duplicated) return;
        duplicated = true;
        const receipt = actor.getSnapshot().context.journals.get("a")?.receipt;
        if (!receipt) throw new TypeError("Missing receipt");
        actor.send({ type: "NODE.REQUEST", id: receipt.id, incarnation: receipt.incarnation, correlation: receipt.correlation, requestSequence: 1, operation: { kind: "gate", costUsd: undefined } });
        actor.send({ type: "NODE.REQUEST", id: receipt.id, incarnation: receipt.incarnation, correlation: receipt.correlation, requestSequence: 1, operation: { kind: "gate", costUsd: undefined } });
      } } },
  });
  actor.start(); expect((await toPromise(actor)).status).toBe("completed");
  expect(gateFrames).toBe(1); expect(acks).toBe(2);
});
