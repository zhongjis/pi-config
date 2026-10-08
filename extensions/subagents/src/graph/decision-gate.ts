import type { ClassifierQuestion, JsonSchema } from "./ir.js";
import { type CompiledSchema, compileJsonSchema } from "./json-schema.js";

/** Applied when neither the node nor the run configures a threshold. */
export const DEFAULT_MIN_CONFIDENCE = 0.8;
const DECIDED_BY = ["classifier", "agent", "orchestrator", "human"] as const;
export type DecidedBy = (typeof DECIDED_BY)[number];
export interface DecisionAnswer {
  readonly value: boolean | string | number;
  readonly confidence: number;
}
/** The only decision_gate output visible to graph wiring. */
export interface DecisionOutput {
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  readonly decidedBy: DecidedBy;
}
type Questions = Readonly<Record<string, ClassifierQuestion>>;

const MAX_REASON = 2000;
const QUESTION_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const unit = { type: "number", minimum: 0, maximum: 1 };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function closed(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
function perQuestion(questions: Questions, schema: (question: ClassifierQuestion) => JsonSchema): JsonSchema {
  return closed(Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, schema(question)])));
}
/** Escalation responses pick exact levels; model answers may report an expected score. */
function valueSchema(question: ClassifierQuestion, exact: boolean): JsonSchema {
  switch (question.type) {
    case "bool": return { type: "boolean" };
    case "choice": return { type: "string", enum: Object.keys(question.criteria) };
    case "score": return { type: exact ? "integer" : "number", minimum: 0, maximum: question.criteria.length - 1 };
  }
}

/** Closed exposed output: `{ answers: { <id>: { value, confidence } }, decidedBy }`. */
export function decisionOutputSchema(questions: Questions): JsonSchema {
  return closed({
    answers: perQuestion(questions, question => closed({ value: valueSchema(question, false), confidence: unit })),
    decidedBy: { type: "string", enum: [...DECIDED_BY] },
  });
}
/** Escalation response: an exact value for every question plus truthful provenance. */
export function decisionResponseSchema(questions: Questions): JsonSchema {
  return closed({
    answers: perQuestion(questions, question => valueSchema(question, true)),
    decidedBy: { type: "string", enum: ["orchestrator", "human"] },
  });
}
/** Agent-fallback StructuredOutput: classifier-shaped evidence, never a bare chosen value. */
export function agentAnswerSchema(questions: Questions): JsonSchema {
  return perQuestion(questions, question => question.type === "bool" ? closed({ probability: unit })
    : question.type === "choice" ? closed({ probabilities: closed(Object.fromEntries(Object.keys(question.criteria).map(label => [label, unit]))) })
    : closed({ score: valueSchema(question, false), confidence: unit }));
}
/** Validated questions always compile; anything else is an internal error. */
export function compileDerivedSchema(schema: JsonSchema): CompiledSchema {
  const compiled = compileJsonSchema(schema);
  if (compiled.ok === false) throw new TypeError(compiled.message);
  return compiled.compiled;
}

function unitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function boolAnswer(id: string, probability: unknown): DecisionAnswer {
  if (!unitNumber(probability)) throw new TypeError(`Invalid probability for decision question "${id}"`);
  return { value: probability >= 0.5, confidence: Math.abs(2 * probability - 1) };
}
function scoreAnswer(id: string, question: Extract<ClassifierQuestion, { type: "score" }>, answer: Record<string, unknown>): DecisionAnswer {
  const { score, confidence } = answer;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > question.criteria.length - 1 || !unitNumber(confidence)) {
    throw new TypeError(`Invalid score answer for decision question "${id}"`);
  }
  return { value: score, confidence };
}
function answerOf(answers: Record<string, unknown>, id: string): Record<string, unknown> {
  const answer = Object.hasOwn(answers, id) ? answers[id] : undefined;
  if (!record(answer)) throw new TypeError(`Missing answer for decision question "${id}"`);
  return answer;
}

/** Map Pi classifier answers; bool confidence is `|2p-1|`, choice/score keep the classifier's. */
export function normalizeClassifierAnswers(questions: Questions, answers: Record<string, unknown>): Record<string, DecisionAnswer> {
  return Object.fromEntries(Object.entries(questions).map(([id, question]): [string, DecisionAnswer] => {
    const answer = answerOf(answers, id);
    if (answer.type !== question.type) throw new TypeError(`Mismatched classifier answer for decision question "${id}"`);
    if (question.type === "bool") return [id, boolAnswer(id, answer.probability)];
    if (question.type === "score") return [id, scoreAnswer(id, question, answer)];
    const { choice, confidence } = answer;
    if (typeof choice !== "string" || !Object.hasOwn(question.criteria, choice) || !unitNumber(confidence)) throw new TypeError(`Invalid choice answer for decision question "${id}"`);
    return [id, { value: choice, confidence }];
  }));
}

/** Map agent StructuredOutput; choice confidence is the normalized peak rescaled to `[0, 1]`. */
export function normalizeAgentAnswers(questions: Questions, output: unknown): Record<string, DecisionAnswer> {
  if (!record(output)) throw new TypeError("Agent decision output must be an object");
  return Object.fromEntries(Object.entries(questions).map(([id, question]): [string, DecisionAnswer] => {
    const answer = answerOf(output, id);
    if (question.type === "bool") return [id, boolAnswer(id, answer.probability)];
    if (question.type === "score") return [id, scoreAnswer(id, question, answer)];
    const labels = Object.keys(question.criteria);
    const raw = answer.probabilities;
    const weights = labels.map(label => record(raw) && Object.hasOwn(raw, label) ? raw[label] : undefined);
    const total = weights.every(unitNumber) ? weights.reduce((sum, weight) => sum + weight, 0) : 0;
    if (!record(raw) || Object.keys(raw).length !== labels.length || !weights.every(unitNumber) || total <= 0) throw new TypeError(`Invalid choice probabilities for decision question "${id}"`);
    const top = Math.max(...weights);
    const peak = top / total;
    return [id, { value: labels[weights.indexOf(top)], confidence: Math.min(1, Math.max(0, (labels.length * peak - 1) / (labels.length - 1))) }];
  }));
}

/** An escalation response decides with certainty; provenance comes from the response. */
export function responseToOutput(questions: Questions, response: unknown): DecisionOutput {
  if (!record(response) || !record(response.answers) || (response.decidedBy !== "orchestrator" && response.decidedBy !== "human")) throw new TypeError("Invalid escalation response");
  const answers = response.answers;
  if (Object.keys(answers).length !== Object.keys(questions).length) throw new TypeError("Escalation response must answer exactly the gate's questions");
  return {
    decidedBy: response.decidedBy,
    answers: Object.fromEntries(Object.entries(questions).map(([id, question]): [string, DecisionAnswer] => {
      const value = Object.hasOwn(answers, id) ? answers[id] : undefined;
      if (typeof value === "boolean" && question.type === "bool") return [id, { value, confidence: 1 }];
      if (typeof value === "string" && question.type === "choice" && Object.hasOwn(question.criteria, value)) return [id, { value, confidence: 1 }];
      if (typeof value === "number" && question.type === "score" && Number.isInteger(value) && value >= 0 && value < question.criteria.length) return [id, { value, confidence: 1 }];
      throw new TypeError(`Invalid escalation answer for decision question "${id}"`);
    })),
  };
}

/** Presentation provenance from a settled decision output. */
export function decidedByOf(output: unknown): DecidedBy | undefined {
  return record(output) ? DECIDED_BY.find(source => source === output.decidedBy) : undefined;
}

export function lowestConfidence(answers: Readonly<Record<string, DecisionAnswer>>): number {
  return Math.min(...Object.values(answers).map(answer => answer.confidence));
}

export type EscalationCause =
  | { readonly kind: "low-confidence"; readonly answers: Readonly<Record<string, DecisionAnswer>>; readonly minConfidence: number; readonly decidedBy: "classifier" | "agent"; readonly model: string }
  | { readonly kind: "exhausted"; readonly error: string };
/** Bounded durable reason: the only escalation evidence a checkpoint keeps. */
export function escalationReason(cause: EscalationCause): string {
  const text = cause.kind === "exhausted" ? `No decision model answered: ${cause.error.trim() || "unknown error"}`
    : `Confidence below ${cause.minConfidence} (${cause.decidedBy} ${cause.model}): ${Object.entries(cause.answers)
      .map(([id, answer]) => `${id}=${JSON.stringify(answer.value)} (${answer.confidence.toFixed(2)})`).join(", ")}`;
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text;
}

function parseQuestion(value: unknown): ClassifierQuestion | { readonly field: string; readonly message: string } {
  if (!record(value)) return { field: "", message: "must be a question object { type, instructions, criteria }" };
  const extra = Object.keys(value).find(key => key !== "type" && key !== "instructions" && key !== "criteria");
  if (extra !== undefined) return { field: `.${extra}`, message: "unknown question field" };
  const { type, instructions, criteria } = value;
  if (type !== "bool" && type !== "choice" && type !== "score") return { field: ".type", message: "must be bool | choice | score" };
  if (!nonEmpty(instructions)) return { field: ".instructions", message: "must be non-empty instructions" };
  if (type === "bool") {
    return record(criteria) && Object.keys(criteria).length === 2 && nonEmpty(criteria.true) && nonEmpty(criteria.false)
      ? { type, instructions, criteria: { true: criteria.true, false: criteria.false } }
      : { field: ".criteria", message: "must be exactly { true, false } with non-empty descriptions" };
  }
  if (type === "choice") {
    const entries = record(criteria) ? Object.entries(criteria) : [];
    const labels = entries.flatMap(([label, description]): [string, string][] => label.trim() && nonEmpty(description) ? [[label, description]] : []);
    return entries.length >= 2 && labels.length === entries.length ? { type, instructions, criteria: Object.fromEntries(labels) }
      : { field: ".criteria", message: "must map at least two non-empty labels to non-empty descriptions" };
  }
  const levels = Array.isArray(criteria) ? criteria.filter(nonEmpty) : [];
  return Array.isArray(criteria) && criteria.length >= 2 && levels.length === criteria.length ? { type, instructions, criteria: levels }
    : { field: ".criteria", message: "must list at least two non-empty level descriptions" };
}

/** Authoring rules; true only when the questions are valid and every derived schema compiles. */
export function validateQuestions(path: string, value: unknown, err: (path: string, message: string) => void): value is Record<string, ClassifierQuestion> {
  if (!record(value) || Object.keys(value).length === 0) {
    err(path, "must be a non-empty object of { id: question }");
    return false;
  }
  const questions: Record<string, ClassifierQuestion> = {};
  let ok = true;
  for (const [id, raw] of Object.entries(value)) {
    const parsed = parseQuestion(raw);
    if (!QUESTION_ID.test(id)) { ok = false; err(`${path}.${id}`, "question id must match ^[A-Za-z][A-Za-z0-9_]*$"); }
    if ("message" in parsed) { ok = false; err(`${path}.${id}${parsed.field}`, parsed.message); }
    else if (ok) questions[id] = parsed;
  }
  if (!ok) return false;
  for (const derive of [decisionOutputSchema, decisionResponseSchema, agentAnswerSchema]) {
    const compiled = compileJsonSchema(derive(questions));
    if (compiled.ok === false) {
      err(path, `derived schema is invalid: ${compiled.message}`);
      return false;
    }
  }
  return true;
}
