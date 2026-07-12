import { describe, expect, it, vi } from "vitest";
import { registerAgentPolicyDenialResultHook } from "../src/agent-policy-denial-result.js";

type Handler = (event: unknown) => unknown;

function registerHook(): Handler {
  let handler: Handler | undefined;
  registerAgentPolicyDenialResultHook({
    on: vi.fn((event: string, next: Handler) => {
      if (event === "tool_result") handler = next;
    }),
  } as never);
  expect(handler).toBeDefined();
  return handler!;
}

const denial = {
  toolName: "Agent",
  content: [{ type: "text", text: "denied raw" }],
  details: {
    category: "delegation_policy_denied",
    invocationStatus: "failed",
    permittedTypes: ["jintong"],
  },
  isError: false,
};

describe("Agent policy-denial tool_result hook", () => {
  it("marks structured policy denials as errors without replacing content or details", () => {
    const handler = registerHook();
    const patch = handler(denial);

    expect(patch).toEqual({ isError: true });
    expect(denial.content).toEqual([{ type: "text", text: "denied raw" }]);
    expect(denial.details).toEqual({
      category: "delegation_policy_denied",
      invocationStatus: "failed",
      permittedTypes: ["jintong"],
    });
  });

  it.each([
    { ...denial, toolName: "read" },
    { ...denial, details: { category: "other" } },
    { ...denial, details: undefined },
    { ...denial, details: null },
    { ...denial, isError: true },
    { toolName: "Agent", content: [], details: { category: "delegation_policy_denied" } },
  ])("leaves successful, unrelated, malformed, or already-error results unchanged", (event) => {
    expect(registerHook()(event)).toBeUndefined();
  });
});
