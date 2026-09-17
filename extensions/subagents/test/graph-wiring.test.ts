import { describe, expect, it } from "vitest";
import { evaluateCondition } from "../src/graph/condition.js";
import type { Condition } from "../src/graph/ir.js";
import { evalPath, MISSING, type ResolutionContext, resolveValueRef } from "../src/graph/value-ref.js";

function ctx(input: unknown, outputs: Record<string, unknown> = {}): ResolutionContext {
  return { input, outputs: new Map(Object.entries(outputs)) };
}

describe("evalPath — minimal JSONPath", () => {
  const root = { a: { b: 2 }, arr: [10, 20], flag: false, s: "" };
  it("returns the whole root for $", () => expect(evalPath("$", root)).toBe(root));
  it("reads a field", () => expect(evalPath("$.a", root)).toEqual({ b: 2 }));
  it("reads a nested field", () => expect(evalPath("$.a.b", root)).toBe(2));
  it("reads an array index", () => expect(evalPath("$.arr[1]", root)).toBe(20));
  it("preserves falsy leaf values", () => {
    expect(evalPath("$.flag", root)).toBe(false);
    expect(evalPath("$.s", root)).toBe("");
  });
  it("returns MISSING for absent field, wrong type, or out-of-range index", () => {
    expect(evalPath("$.nope", root)).toBe(MISSING);
    expect(evalPath("$.a.b.c", root)).toBe(MISSING);
    expect(evalPath("$.arr[5]", root)).toBe(MISSING);
  });
  it("returns MISSING for a malformed or non-$ path", () => {
    expect(evalPath("a.b", root)).toBe(MISSING);
    expect(evalPath("$..a", root)).toBe(MISSING);
  });
});

describe("resolveValueRef", () => {
  it("reads the graph input when node is omitted", () => {
    expect(resolveValueRef({ path: "$.task" }, ctx({ task: "x" }))).toBe("x");
  });
  it("reads a settled node output", () => {
    expect(resolveValueRef({ node: "review", path: "$.approved" }, ctx(null, { review: { approved: true } }))).toBe(true);
  });
  it("returns MISSING for an unsettled node", () => {
    expect(resolveValueRef({ node: "ghost", path: "$.x" }, ctx(null, {}))).toBe(MISSING);
  });
});

describe("evaluateCondition", () => {
  const c = ctx(null, { review: { approved: false, score: 3, issues: ["a"] }, empty: {} });

  it("eq / ne against a settled value", () => {
    expect(evaluateCondition({ eq: [{ node: "review", path: "$.approved" }, false] }, c)).toBe(true);
    expect(evaluateCondition({ eq: [{ node: "review", path: "$.approved" }, true] }, c)).toBe(false);
    expect(evaluateCondition({ ne: [{ node: "review", path: "$.approved" }, true] }, c)).toBe(true);
  });

  it("treats a missing ref as unsatisfied for eq and satisfied for ne", () => {
    expect(evaluateCondition({ eq: [{ node: "ghost", path: "$.x" }, 1] }, c)).toBe(false);
    expect(evaluateCondition({ ne: [{ node: "ghost", path: "$.x" }, 1] }, c)).toBe(true);
  });

  it("numeric comparisons require an actual number", () => {
    expect(evaluateCondition({ gt: [{ node: "review", path: "$.score" }, 2] }, c)).toBe(true);
    expect(evaluateCondition({ lte: [{ node: "review", path: "$.score" }, 3] }, c)).toBe(true);
    expect(evaluateCondition({ gt: [{ node: "review", path: "$.approved" }, 0] }, c)).toBe(false);
    expect(evaluateCondition({ gt: [{ node: "ghost", path: "$.x" }, 0] }, c)).toBe(false);
  });

  it("exists is true for any present non-null value, including falsy", () => {
    expect(evaluateCondition({ exists: { node: "review", path: "$.approved" } }, c)).toBe(true);
    expect(evaluateCondition({ exists: { node: "review", path: "$.missing" } }, c)).toBe(false);
  });

  it("composes and / or / not", () => {
    const cond: Condition = {
      and: [
        { eq: [{ node: "review", path: "$.approved" }, false] },
        { or: [{ gt: [{ node: "review", path: "$.score" }, 10] }, { not: { exists: { node: "review", path: "$.gone" } } }] },
      ],
    };
    expect(evaluateCondition(cond, c)).toBe(true);
  });

  it("does structural equality on arrays and objects", () => {
    expect(evaluateCondition({ eq: [{ node: "review", path: "$.issues" }, ["a"]] }, c)).toBe(true);
    expect(evaluateCondition({ eq: [{ node: "review", path: "$.issues" }, ["a", "b"]] }, c)).toBe(false);
    expect(evaluateCondition({ eq: [{ node: "empty", path: "$" }, {}] }, c)).toBe(true);
  });
});
