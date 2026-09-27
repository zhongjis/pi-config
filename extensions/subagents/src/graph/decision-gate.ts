import { type CompiledSchema, compileJsonSchema } from "./json-schema.js";

/** The only decision value visible to graph wiring. */
export const decisionValueSchema = {
  type: "object", properties: { approved: { type: "boolean" } },
  required: ["approved"], additionalProperties: false,
};

/** Private Subagent protocol; never exposed as a node's output. */
export const agentDecisionSchema = {
  type: "object",
  oneOf: [
    { type: "object", properties: { status: { const: "decided" }, decision: decisionValueSchema }, required: ["status", "decision"], additionalProperties: false },
    { type: "object", properties: { status: { const: "undecided" }, reason: { type: "string", pattern: "\\S" } }, required: ["status", "reason"], additionalProperties: false },
  ],
};
export type AgentDecision =
  | { readonly status: "decided"; readonly decision: { readonly approved: boolean } }
  | { readonly status: "undecided"; readonly reason: string };

export function compileDecisionSchema(outputSchema: unknown): CompiledSchema {
  const compiled = compileJsonSchema({ type: "object", allOf: [decisionValueSchema, outputSchema] });
  if (!compiled.ok) throw new TypeError(compiled.message);
  return compiled.compiled;
}
const internal = compileJsonSchema(agentDecisionSchema);
if (!internal.ok) throw new TypeError(internal.message);
export const compiledAgentDecisionSchema = internal.compiled;

/** Parse even when a custom host claims its structured output was validated. */
export function parseAgentDecision(output: string | undefined): AgentDecision {
  const value: unknown = JSON.parse(output ?? "null");
  const valid = compiledAgentDecisionSchema.check(value);
  if (valid !== true) throw new TypeError(`Invalid agent decision: ${valid}`);
  // Narrow after schema checking without asserting a type at this trust boundary.
  if (typeof value === "object" && value !== null && "status" in value) {
    if (value.status === "undecided" && "reason" in value && typeof value.reason === "string") return { status: "undecided", reason: value.reason };
    if (value.status === "decided" && "decision" in value && typeof value.decision === "object" && value.decision !== null && "approved" in value.decision && typeof value.decision.approved === "boolean") {
      return { status: "decided", decision: { approved: value.decision.approved } };
    }
  }
  throw new TypeError("Invalid agent decision");
}
