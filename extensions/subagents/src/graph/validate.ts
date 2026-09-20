/**
 * validate.ts — structural + schema validation for the AgentGraph IR.
 *
 * Runs before anything executes, so a malformed graph fails at the tool call
 * rather than mid-run. Two entry points share one core: {@link validateGraph}
 * for a saved/inline graph, and {@link validateFragment} for a runtime
 * expansion, which is held to the same rules against the ids already in the run.
 *
 * The check is deliberately exhaustive over the IR shape (docs/ideas/
 * agent-graph-design-v2.md §1.8): every node type, every reference, every edge,
 * every condition, and every embedded JSON Schema. Errors accumulate so an
 * author sees all of them at once instead of one per round-trip.
 */

import { type GraphNode, NODE_TYPES, type NodeId } from "./ir.js";
import { compileInputSchema, compileJsonSchema } from "./json-schema.js";
import { isJsonPath } from "./value-ref.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Hard ceiling on node count for a single graph or fragment. */
export const MAX_NODES = 500;

const NODE_TYPE_SET = new Set<string>(NODE_TYPES);
const COMPARISON_OPS = new Set(["eq", "ne", "gt", "gte", "lt", "lte"]);
const NUMERIC_OPS = new Set(["gt", "gte", "lt", "lte"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Accumulates errors under a dotted path so each message says where it is.
 * `known` is the set of node ids a reference may point at — for a fragment this
 * includes ids already present in the run graph.
 */
// allow: SIZE_OK — IR validation shares one locating error accumulator and known-node set.
class Validator {
  readonly errors: string[] = [];

  constructor(private readonly known: Set<NodeId>) {}

  private err(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }

  valueRef(path: string, ref: unknown): void {
    if (!isPlainObject(ref)) {
      this.err(path, "must be a ValueRef object { node?, path }");
      return;
    }
    if (ref.node !== undefined) {
      if (typeof ref.node !== "string") this.err(`${path}.node`, "must be a node id string");
      else if (!this.known.has(ref.node)) this.err(`${path}.node`, `references unknown node "${ref.node}"`);
    }
    if (typeof ref.path !== "string" || !ref.path.startsWith("$")) {
      this.err(`${path}.path`, 'must be a JSONPath string starting with "$"');
    }
  }

  condition(path: string, cond: unknown): void {
    if (!isPlainObject(cond)) {
      this.err(path, "must be a condition object");
      return;
    }
    const keys = Object.keys(cond);
    if (keys.length !== 1) {
      this.err(path, `must have exactly one operator, found: ${keys.join(", ") || "none"}`);
      return;
    }
    const op = keys[0];
    const operand = cond[op];
    if (COMPARISON_OPS.has(op)) {
      if (!Array.isArray(operand) || operand.length !== 2) {
        this.err(`${path}.${op}`, "must be a [ValueRef, value] pair");
        return;
      }
      this.valueRef(`${path}.${op}[0]`, operand[0]);
      if (NUMERIC_OPS.has(op) && typeof operand[1] !== "number") {
        this.err(`${path}.${op}[1]`, "must be a number");
      }
      return;
    }
    if (op === "exists") {
      this.valueRef(`${path}.exists`, operand);
      return;
    }
    if (op === "and" || op === "or") {
      if (!Array.isArray(operand) || operand.length === 0) {
        this.err(`${path}.${op}`, "must be a non-empty array of conditions");
        return;
      }
      operand.forEach((sub, i) => {
        this.condition(`${path}.${op}[${i}]`, sub);
      });
      return;
    }
    if (op === "not") {
      this.condition(`${path}.not`, operand);
      return;
    }
    this.err(path, `unknown operator "${op}"`);
  }

  inputMap(path: string, input: unknown): void {
    if (input === undefined) return;
    if (!isPlainObject(input)) {
      this.err(path, "must be an object of { name: ValueRef }");
      return;
    }
    for (const [key, ref] of Object.entries(input)) this.valueRef(`${path}.${key}`, ref);
  }

  schema(path: string, schema: unknown, objectRoot: boolean): void {
    const compiled = objectRoot ? compileJsonSchema(schema) : compileInputSchema(schema);
    if (compiled.ok === false) this.err(path, compiled.message);
  }

  /**
   * A prompt template resolves `${name}` only from the node's own `input` map
   * (see run-graph.ts `interpolate`), so an unmapped placeholder would silently
   * reach the agent as a literal `${name}`. Flag it at authoring time instead.
   */
  promptPlaceholders(path: string, prompt: unknown, input: unknown): void {
    if (typeof prompt !== "string") return;
    const keys = isPlainObject(input) ? new Set(Object.keys(input)) : new Set<string>();
    const re = /\$\{([A-Za-z_$][\w$]*)\}/g;
    const missing = new Set<string>();
    for (let match = re.exec(prompt); match !== null; match = re.exec(prompt)) {
      if (!keys.has(match[1])) missing.add(match[1]);
    }
    for (const name of missing) {
      this.err(`${path}.prompt`, `references \${${name}} but node.input has no "${name}" mapping`);
    }
  }

  node(id: NodeId, node: unknown): void {
    const path = `nodes.${id}`;
    if (!isPlainObject(node)) {
      this.err(path, "must be an object");
      return;
    }
    if (node.name !== undefined && typeof node.name !== "string") this.err(`${path}.name`, "must be a string");
    const type = node.type;
    if (typeof type !== "string" || !NODE_TYPE_SET.has(type)) {
      this.err(`${path}.type`, `must be one of ${NODE_TYPES.join(" | ")}`);
      return;
    }
    switch (type as GraphNode["type"]) {
      case "agent":
        if (!isNonEmptyString(node.agent)) this.err(`${path}.agent`, "must be a non-empty agent selector");
        if (!isNonEmptyString(node.prompt)) this.err(`${path}.prompt`, "must be a non-empty prompt");
        this.inputMap(`${path}.input`, node.input);
        this.promptPlaceholders(path, node.prompt, node.input);
        if (node.outputSchema !== undefined) this.schema(`${path}.outputSchema`, node.outputSchema, true);
        if (node.validation !== undefined) {
          if (!isPlainObject(node.validation)) this.err(`${path}.validation`, "must be an object");
          else if (node.validation.gate !== undefined && !isNonEmptyString(node.validation.gate)) {
            this.err(`${path}.validation.gate`, "must be a non-empty command string");
          }
        }
        if (node.retry !== undefined) {
          if (!isPlainObject(node.retry) || !isPositiveInt(node.retry.maxAttempts)) {
            this.err(`${path}.retry.maxAttempts`, "must be a positive integer");
          }
        }
        if (node.resources !== undefined) {
          if (!Array.isArray(node.resources) || !node.resources.every(isNonEmptyString)) {
            this.err(`${path}.resources`, "must be an array of non-empty resource strings");
          }
        }
        break;
      case "bounded_feedback":
        for (const bound of ["maxIterations", "maxItemsPerIteration", "maxTotalItems"]) {
          if (!isPositiveInt(node[bound]) || !Number.isSafeInteger(node[bound])) this.err(`${path}.${bound}`, "must be a positive safe integer");
        }
        if (node.deadline !== undefined && (!isPositiveInt(node.deadline) || !Number.isSafeInteger(node.deadline))) this.err(`${path}.deadline`, "must be positive safe integer milliseconds");
        if (node.spendLimit !== undefined && (typeof node.spendLimit !== "number" || !Number.isFinite(node.spendLimit) || node.spendLimit <= 0)) this.err(`${path}.spendLimit`, "must be positive finite USD");
        for (const key of Object.keys(node)) if (!["type", "name", "work", "evaluator", "maxIterations", "maxItemsPerIteration", "maxTotalItems", "deadline", "spendLimit"].includes(key)) this.err(`${path}.${key}`, "unknown bounded-feedback field");
        if (!isPlainObject(node.work) || node.work.type !== "fanout") this.err(`${path}.work`, "must be a fixed fanout template");
        else {
          this.node(`${id}.work`, node.work);
          if (node.work.outputSchema === undefined) this.err(`${path}.work.outputSchema`, "is required for validated evidence");
        }
        if (!isPlainObject(node.evaluator) || node.evaluator.type !== "agent") this.err(`${path}.evaluator`, "must be a fixed agent template");
        else {
          this.node(`${id}.evaluator`, { ...node.evaluator, input: { ...(isPlainObject(node.evaluator.input) ? node.evaluator.input : {}), feedback: { path: "$" } } });
          if (isPlainObject(node.evaluator.input) && Object.hasOwn(node.evaluator.input, "feedback")) this.err(path, "evaluator.input.feedback is reserved");
          if (node.evaluator.outputSchema !== undefined) this.err(path, "evaluator outputSchema is runtime-owned");
        }
        break;
      case "fanout":
        this.valueRef(`${path}.items`, node.items);
        this.schema(`${path}.itemSchema`, node.itemSchema, true);
        if (node.outputSchema !== undefined) this.schema(`${path}.outputSchema`, node.outputSchema, true);
        if (!isNonEmptyString(node.prompt)) this.err(`${path}.prompt`, "must be a non-empty prompt");
        this.inputMap(`${path}.input`, node.input);
        if (isPlainObject(node.input) && Object.hasOwn(node.input, "item")) {
          this.err(`${path}.input.item`, "is reserved for the fanout item");
        }
        this.promptPlaceholders(path, node.prompt, { ...(isPlainObject(node.input) ? node.input : {}), item: true });
        if (!isPlainObject(node.dispatch)) this.err(`${path}.dispatch`, "must be an object { path, cases }");
        else {
          if (typeof node.dispatch.path !== "string" || !isJsonPath(node.dispatch.path)) {
            this.err(`${path}.dispatch.path`, "must be a supported JSONPath string");
          }
          if (!isPlainObject(node.dispatch.cases) || Object.keys(node.dispatch.cases).length === 0) {
            this.err(`${path}.dispatch.cases`, "must be a non-empty dispatch table");
          } else {
            for (const [key, selector] of Object.entries(node.dispatch.cases)) {
              if (!isNonEmptyString(selector)) this.err(`${path}.dispatch.cases.${key}`, "must be a non-empty agent selector");
            }
          }
        }
        if (node.phase !== undefined) {
          if (!isPlainObject(node.phase)) this.err(`${path}.phase`, "must be an object { index, title }");
          else {
            if (typeof node.phase.index !== "number" || !Number.isInteger(node.phase.index) || node.phase.index < 0) {
              this.err(`${path}.phase.index`, "must be a non-negative integer");
            }
            if (!isNonEmptyString(node.phase.title)) this.err(`${path}.phase.title`, "must be a non-empty title");
          }
        }
        break;
      case "human_gate":
        if (!isNonEmptyString(node.prompt)) this.err(`${path}.prompt`, "must be a non-empty prompt");
        this.inputMap(`${path}.input`, node.input);
        this.promptPlaceholders(path, node.prompt, node.input);
        if (node.outputSchema === undefined) this.err(`${path}.outputSchema`, "is required for a human_gate node");
        else this.schema(`${path}.outputSchema`, node.outputSchema, true);
        break;
      case "graph":
        if (!isNonEmptyString(node.graph)) this.err(`${path}.graph`, "must be a non-empty saved-graph reference");
        this.inputMap(`${path}.input`, node.input);
        break;
      case "expand":
        this.valueRef(`${path}.source`, node.source);
        if (node.namespace !== undefined && !isNonEmptyString(node.namespace)) {
          this.err(`${path}.namespace`, "must be a non-empty string when present");
        }
        break;
    }
  }

  edge(index: number, edge: unknown): void {
    const path = `edges[${index}]`;
    if (!isPlainObject(edge)) {
      this.err(path, "must be an object { from, to }");
      return;
    }
    for (const end of ["from", "to"] as const) {
      const id = edge[end];
      if (typeof id !== "string") this.err(`${path}.${end}`, "must be a node id string");
      else if (!this.known.has(id)) this.err(`${path}.${end}`, `references unknown node "${id}"`);
    }
    if (edge.when !== undefined) this.condition(`${path}.when`, edge.when);
    if (edge.loop !== undefined) {
      if (!isPlainObject(edge.loop) || !isPositiveInt(edge.loop.maxIterations)) {
        this.err(`${path}.loop.maxIterations`, "must be a positive integer");
      }
    }
  }

  outputs(path: string, outputs: unknown): void {
    if (outputs === undefined) return;
    if (!isPlainObject(outputs)) {
      this.err(path, "must be an object of { name: ValueRef }");
      return;
    }
    for (const [key, ref] of Object.entries(outputs)) this.valueRef(`${path}.${key}`, ref);
  }
}

/**
 * Validate the `nodes`/`edges`/`outputs` core shared by a graph and a fragment.
 *
 * `existingIds` are node ids already present in the run (empty for a top-level
 * graph). Fragment node ids must not collide with them; edges and refs may point
 * at either set.
 */
function validateCore(
  nodes: unknown,
  edges: unknown,
  outputs: unknown,
  existingIds: Set<NodeId>,
): ValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(nodes)) {
    return { ok: false, errors: ["nodes: must be an object of { id: GraphNode }"] };
  }
  const ids = Object.keys(nodes);
  if (ids.length === 0) errors.push("nodes: must declare at least one node");
  const effectiveCount = existingIds.size + ids.length;
  if (effectiveCount > MAX_NODES) errors.push(`nodes: ${effectiveCount} nodes exceeds the limit of ${MAX_NODES}`);
  for (const id of ids) {
    if (!isNonEmptyString(id)) errors.push(`nodes: node id "${id}" must be a non-empty string`);
    if (existingIds.has(id)) errors.push(`nodes.${id}: collides with an id already in the run graph`);
  }

  const known = new Set<NodeId>([...existingIds, ...ids]);
  const validator = new Validator(known);
  for (const id of ids) validator.node(id, (nodes as Record<string, unknown>)[id]);

  if (edges !== undefined) {
    if (!Array.isArray(edges)) errors.push("edges: must be an array");
    else {
      edges.forEach((edge, i) => {
        validator.edge(i, edge);
        if (isPlainObject(edge) && edge.loop !== undefined && typeof edge.to === "string") {
          const target = nodes[edge.to];
          if (isPlainObject(target) && (target.type === "fanout" || target.type === "bounded_feedback")) errors.push(`edges[${i}].to: a fanout cannot be a loop target`);
        }
      });
    }
  }

  validator.outputs("outputs", outputs);

  errors.push(...validator.errors);
  return { ok: errors.length === 0, errors };
}

/** Validate a complete graph (saved or inline). */
export function validateGraph(graph: unknown): ValidationResult {
  if (!isPlainObject(graph)) {
    return { ok: false, errors: ["graph: must be an object"] };
  }
  const errors: string[] = [];
  if (graph.id !== undefined && !isNonEmptyString(graph.id)) errors.push("id: must be a non-empty string when present");
  if (graph.name !== undefined && typeof graph.name !== "string") errors.push("name: must be a string when present");
  if (graph.version !== undefined && graph.version !== 1 && graph.version !== 2) errors.push("version: supported versions are 1 and 2");
  if (graph.description !== undefined && typeof graph.description !== "string") errors.push("description: must be a string when present");
  if (graph.inputSchema !== undefined) {
    const compiled = compileInputSchema(graph.inputSchema);
    if (compiled.ok === false) errors.push(`inputSchema: ${compiled.message}`);
  }
  if (graph.outputSchema !== undefined) {
    const compiled = compileInputSchema(graph.outputSchema);
    if (compiled.ok === false) errors.push(`outputSchema: ${compiled.message}`);
  }

  if (graph.version !== 2 && isPlainObject(graph.nodes)) {
    for (const [id, node] of Object.entries(graph.nodes)) if (isPlainObject(node) && node.type === "bounded_feedback") errors.push(`nodes.${id}: bounded feedback requires version 2`);
  }
  const core = validateCore(graph.nodes, graph.edges, graph.outputs, new Set());
  errors.push(...core.errors);
  return { ok: errors.length === 0, errors };
}

/** Validate a runtime expansion fragment against the ids already in the run. */
export function validateFragment(fragment: unknown, existingIds: Iterable<NodeId>): ValidationResult {
  if (!isPlainObject(fragment)) {
    return { ok: false, errors: ["fragment: must be an object { nodes, edges }"] };
  }
  const result = validateCore(fragment.nodes, fragment.edges, fragment.outputs, new Set(existingIds));
  if (isPlainObject(fragment.nodes)) {
    for (const [id, node] of Object.entries(fragment.nodes)) {
      if (isPlainObject(node) && (node.type === "fanout" || node.type === "bounded_feedback")) {
        result.errors.push(`nodes.${id}: fanout is not allowed in runtime fragments; selectors require static delegation preflight`);
      }
    }
  }
  return { ok: result.errors.length === 0, errors: result.errors };
}
