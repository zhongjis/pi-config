import { describe, expect, it } from "vitest";
import { agentAnswerSchema, compileDerivedSchema, decisionOutputSchema, decisionResponseSchema, escalationReason, lowestConfidence, normalizeAgentAnswers, normalizeClassifierAnswers, responseToOutput } from "../src/graph/decision-gate.js";
import type { ClassifierQuestion } from "../src/graph/ir.js";
import { validateGraph } from "../src/graph/validate.js";

const questions = {
  ship: { type: "bool", instructions: "Ship it?", criteria: { true: "Ready", false: "Not ready" } },
  route: { type: "choice", instructions: "Which route?", criteria: { fast: "Fast path", safe: "Safe path", none: "Stop" } },
  risk: { type: "score", instructions: "How risky?", criteria: ["low", "medium", "high"] },
} satisfies Record<string, ClassifierQuestion>;
const gate = { type: "decision_gate", state: { plan: { path: "$.plan" } }, questions };
const answers = { ship: { value: true, confidence: 0.9 }, route: { value: "safe", confidence: 0.7 }, risk: { value: 1.4, confidence: 0.8 } };
const errors = (node: Record<string, unknown>, when?: unknown) => validateGraph({
  nodes: { gate: node, next: { type: "agent", agent: "worker", prompt: "Next" } },
  edges: [{ from: "gate", to: "next", ...(when === undefined ? {} : { when }) }],
}).errors;
const ref = (path: string) => ({ exists: { node: "gate", path } });

describe("decision_gate validation", () => {
  it("accepts bool, choice and score questions over ValueRef state", () => {
    expect(errors(gate)).toEqual([]);
  });

  it("accepts empty state", () => {
    expect(errors({ ...gate, state: {} })).toEqual([]);
  });

  it.each([
    ["missing state", { ...gate, state: undefined }, "nodes.gate.state"],
    ["non-ValueRef state", { ...gate, state: { plan: "$.plan" } }, "nodes.gate.state.plan"],
    ["empty questions", { ...gate, questions: {} }, "nodes.gate.questions"],
    ["invalid question id", { ...gate, questions: { "1ship": questions.ship } }, "nodes.gate.questions.1ship"],
    ["blank instructions", { ...gate, questions: { ship: { ...questions.ship, instructions: " " } } }, "nodes.gate.questions.ship.instructions"],
    ["bool criteria beyond true/false", { ...gate, questions: { ship: { ...questions.ship, criteria: { true: "Y", false: "N", maybe: "?" } } } }, "nodes.gate.questions.ship.criteria"],
    ["single choice label", { ...gate, questions: { route: { ...questions.route, criteria: { fast: "Fast" } } } }, "nodes.gate.questions.route.criteria"],
    ["blank choice description", { ...gate, questions: { route: { ...questions.route, criteria: { fast: "Fast", safe: "" } } } }, "nodes.gate.questions.route.criteria"],
    ["single score level", { ...gate, questions: { risk: { ...questions.risk, criteria: ["only"] } } }, "nodes.gate.questions.risk.criteria"],
    ["unknown question type", { ...gate, questions: { ship: { ...questions.ship, type: "rank" } } }, "nodes.gate.questions.ship.type"],
    ["unknown question field", { ...gate, questions: { ship: { ...questions.ship, examples: [] } } }, "nodes.gate.questions.ship.examples"],
    ["minConfidence above 1", { ...gate, minConfidence: 1.5 }, "nodes.gate.minConfidence"],
    ["non-finite minConfidence", { ...gate, minConfidence: Number.NaN }, "nodes.gate.minConfidence"],
    ["string minConfidence", { ...gate, minConfidence: "0.9" }, "nodes.gate.minConfidence"],
    ["leftover prompt", { ...gate, prompt: "Approve?" }, "nodes.gate.prompt"],
    ["leftover agent", { ...gate, agent: "reviewer" }, "nodes.gate.agent"],
    ["leftover outputSchema", { ...gate, outputSchema: { type: "object" } }, "nodes.gate.outputSchema"],
  ])("rejects %s", (_label, node, path) => {
    expect(errors(node).some(error => error.startsWith(`${path}:`))).toBe(true);
  });

  it.each(["human_gate", "agent_gate", "hybrid_gate"])("rejects the removed %s type", type => {
    expect(errors({ type, agent: "reviewer", prompt: "Approve?", outputSchema: { type: "object" } })).toEqual([expect.stringMatching(/^nodes\.gate\.type: must be one of .*decision_gate/)]);
  });

  it.each(["$.answers.ship.value", "$.answers.route.confidence", "$.decidedBy"])("accepts edge path %s", path => {
    expect(errors(gate, ref(path))).toEqual([]);
  });

  it.each(["$.answers.shp.value", "$.answers.ship.score", "$.answers.ship.value.detail", "$.approved"])("rejects impossible edge path %s", path => {
    expect(errors(gate, ref(path))).toEqual([expect.stringContaining("cannot exist")]);
  });
});

describe("derived decision schemas", () => {
  const output = compileDerivedSchema(decisionOutputSchema(questions));
  const response = compileDerivedSchema(decisionResponseSchema(questions));
  const agent = compileDerivedSchema(agentAnswerSchema(questions));

  it("exposes every answer with its value and confidence", () => {
    expect(output.check({ answers, decidedBy: "classifier" })).toBe(true);
  });

  it.each([
    ["choice outside labels", { answers: { ...answers, route: { value: "slow", confidence: 0.7 } }, decidedBy: "agent" }],
    ["score beyond levels", { answers: { ...answers, risk: { value: 3, confidence: 0.7 } }, decidedBy: "agent" }],
    ["confidence above 1", { answers: { ...answers, ship: { value: true, confidence: 1.1 } }, decidedBy: "agent" }],
    ["missing answer", { answers: { ship: answers.ship, route: answers.route }, decidedBy: "agent" }],
    ["extra field", { answers, decidedBy: "agent", reason: "extra" }],
    ["unknown provenance", { answers, decidedBy: "policy" }],
  ])("output rejects %s", (_label, value) => {
    expect(output.check(value)).not.toBe(true);
  });

  it("response accepts exact values and truthful provenance", () => {
    expect(response.check({ answers: { ship: false, route: "fast", risk: 2 }, decidedBy: "human" })).toBe(true);
  });

  it.each([
    ["model provenance", { answers: { ship: false, route: "fast", risk: 2 }, decidedBy: "classifier" }],
    ["fractional score", { answers: { ship: false, route: "fast", risk: 1.5 }, decidedBy: "orchestrator" }],
    ["wrapped value", { answers: { ship: { value: false }, route: "fast", risk: 2 }, decidedBy: "orchestrator" }],
    ["missing answer", { answers: { ship: false, route: "fast" }, decidedBy: "orchestrator" }],
  ])("response rejects %s", (_label, value) => {
    expect(response.check(value)).not.toBe(true);
  });

  it("agent schema asks for classifier-shaped evidence per question", () => {
    expect(agent.check({ ship: { probability: 0.7 }, route: { probabilities: { fast: 0.1, safe: 0.8, none: 0.1 } }, risk: { score: 1.2, confidence: 0.6 } })).toBe(true);
  });

  it("agent schema rejects a bare chosen value", () => {
    expect(agent.check({ ship: true, route: "safe", risk: 1 })).not.toBe(true);
  });

  it("agent schema advertises every question as a top-level provider property", () => {
    expect(agent.providerSchema).toMatchObject({ type: "object", properties: { ship: {}, route: {}, risk: {} } });
  });
});

describe("answer normalization", () => {
  it.each([[0.5, true, 0], [0.1, false, 0.8], [1, true, 1]])("classifier bool probability %s maps to %s with confidence %s", (probability, value, confidence) => {
    const [answer] = Object.values(normalizeClassifierAnswers({ ship: questions.ship }, { ship: { type: "bool", probability } }));
    expect(answer).toEqual({ value, confidence: expect.closeTo(confidence, 10) });
  });

  it("classifier choice and score keep the classifier's confidence", () => {
    expect(normalizeClassifierAnswers({ route: questions.route, risk: questions.risk }, {
      route: { type: "choice", choice: "safe", probabilities: { fast: 0.2, safe: 0.7, none: 0.1 }, confidence: 0.55 },
      risk: { type: "score", score: 1.4, confidence: 0.65 },
    })).toEqual({ route: { value: "safe", confidence: 0.55 }, risk: { value: 1.4, confidence: 0.65 } });
  });

  it.each([
    ["missing answer", {}],
    ["mismatched type", { ship: { type: "choice", choice: "true", probabilities: {}, confidence: 1 } }],
    ["probability above 1", { ship: { type: "bool", probability: 1.2 } }],
  ])("classifier rejects %s", (_label, value) => {
    expect(() => normalizeClassifierAnswers({ ship: questions.ship }, value)).toThrow(TypeError);
  });

  it.each([
    ["normalized", { fast: 0.2, safe: 0.6, none: 0.2 }],
    ["unnormalized", { fast: 0.1, safe: 0.3, none: 0.1 }],
  ])("agent choice confidence rescales the %s peak", (_label, probabilities) => {
    expect(normalizeAgentAnswers({ route: questions.route }, { route: { probabilities } }).route).toEqual({ value: "safe", confidence: expect.closeTo(0.4, 10) });
  });

  it("agent bool and score use the classifier formulas", () => {
    expect(normalizeAgentAnswers({ ship: questions.ship, risk: questions.risk }, { ship: { probability: 0.2 }, risk: { score: 2, confidence: 0.5 } }))
      .toEqual({ ship: { value: false, confidence: expect.closeTo(0.6, 10) }, risk: { value: 2, confidence: 0.5 } });
  });

  it.each([
    ["zero-sum probabilities", { route: { probabilities: { fast: 0, safe: 0, none: 0 } } }],
    ["extra label", { route: { probabilities: { fast: 0.2, safe: 0.6, none: 0.2, maybe: 0.1 } } }],
    ["missing label", { route: { probabilities: { fast: 0.2, safe: 0.8 } } }],
    ["non-object output", "safe"],
  ])("agent rejects %s", (_label, value) => {
    expect(() => normalizeAgentAnswers({ route: questions.route }, value)).toThrow(TypeError);
  });

  it("lowest confidence is the minimum answer confidence", () => {
    expect(lowestConfidence(answers)).toBe(0.7);
  });
});

describe("escalation responses and reasons", () => {
  it("a response decides with certainty under its own provenance", () => {
    expect(responseToOutput(questions, { answers: { ship: false, route: "fast", risk: 2 }, decidedBy: "human" })).toEqual({
      answers: { ship: { value: false, confidence: 1 }, route: { value: "fast", confidence: 1 }, risk: { value: 2, confidence: 1 } }, decidedBy: "human",
    });
  });

  it.each([
    ["wrong value type", { answers: { ship: "no", route: "fast", risk: 2 }, decidedBy: "human" }],
    ["extra answer", { answers: { ship: false, route: "fast", risk: 2, more: true }, decidedBy: "human" }],
    ["model provenance", { answers: { ship: false, route: "fast", risk: 2 }, decidedBy: "agent" }],
  ])("a response with %s is rejected", (_label, value) => {
    expect(() => responseToOutput(questions, value)).toThrow(TypeError);
  });

  it("a low-confidence reason names each answer, the threshold, the decider and its model", () => {
    const reason = escalationReason({ kind: "low-confidence", answers, minConfidence: 0.85, decidedBy: "agent", model: "test/model" });
    for (const part of ["ship=true", "0.90", 'route="safe"', "0.70", "0.85", "agent", "test/model"]) expect(reason).toContain(part);
  });

  it("an exhausted reason carries the chain error", () => {
    expect(escalationReason({ kind: "exhausted", error: "every entry failed" })).toContain("every entry failed");
  });

  it("reasons stay bounded", () => {
    expect(escalationReason({ kind: "exhausted", error: "x".repeat(5000) }).length).toBeLessThanOrEqual(2000);
  });
});
