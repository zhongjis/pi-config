import { describe, expect, it } from "vitest";
import { compileDecisionSchema, compiledAgentDecisionSchema, decisionValueSchema, parseAgentDecision } from "../src/graph/decision-gate.js";
import { validateGraph } from "../src/graph/validate.js";

describe("decision gate contracts", () => {
  it.each(["human_gate", "agent_gate", "hybrid_gate"])("validates %s and its exposed schema", type => {
    const node = { type, prompt: "Decide", outputSchema: decisionValueSchema, ...(type === "human_gate" ? {} : { agent: "reviewer" }) };
    expect(validateGraph({ nodes: { gate: node }, edges: [] }).ok).toBe(true);
    expect(validateGraph({ nodes: { gate: { ...node, outputSchema: { type: "object", required: ["reason"] } } }, edges: [] }).ok).toBe(false);
  });
  it.each(["agent_gate", "hybrid_gate"])("requires a selector for %s", type => {
    expect(validateGraph({ nodes: { gate: { type, prompt: "Decide", outputSchema: decisionValueSchema } }, edges: [] }).ok).toBe(false);
  });
  it("keeps the private protocol distinct from exposed decisions", () => {
    expect(parseAgentDecision('{"status":"decided","decision":{"approved":false}}')).toEqual({ status: "decided", decision: { approved: false } });
    expect(parseAgentDecision('{"status":"undecided","reason":"Need confirmation"}')).toEqual({ status: "undecided", reason: "Need confirmation" });
    const schema = compileDecisionSchema({ type: "object" });
    expect(schema.check({ approved: true })).toBe(true);
    expect(schema.check({ approved: true, reason: "extra" })).not.toBe(true);
    expect(schema.check({ status: "decided", decision: { approved: true } })).not.toBe(true);
  });
  it.each([{}, { approved: true }, { status: "undecided", reason: " " }, { status: "undecided" }, { status: "unable", reason: "No tools" }, { status: "decided", decision: { approved: true, extra: 1 } }, { status: "decided", decision: { approved: "yes" } }])("rejects malformed private output %j", value => {
    expect(() => parseAgentDecision(JSON.stringify(value))).toThrow();
  });
  it.each([
    { status: "decided", decision: { approved: true }, reason: "extra" },
    { status: "undecided", reason: "Unclear", decision: { approved: false } },
    { status: "decided", decision: "approve" },
  ])("rejects mixed private output %j", value => {
    expect(() => parseAgentDecision(JSON.stringify(value))).toThrow();
  });
  it("advertises top-level properties so providers that ignore root combinators still see the fields", () => {
    expect(compiledAgentDecisionSchema.providerSchema).toMatchObject({ type: "object", properties: { status: {}, decision: {}, reason: {} } });
    expect(compiledAgentDecisionSchema.providerSchema).not.toHaveProperty("oneOf");
  });
});
