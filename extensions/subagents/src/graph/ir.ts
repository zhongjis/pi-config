/**
 * ir.ts — the AgentGraph intermediate representation.
 *
 * This is the stable, product-level contract: pure data that drives execution,
 * persistence, validation, and the monitor. It is deliberately independent of
 * XState (the execution substrate) so the runtime underneath can change without
 * touching saved graphs.
 *
 * The IR is data, not code. No node embeds JavaScript; control flow is expressed
 * with declarative {@link Condition}s on edges, and every value that crosses
 * between nodes is a {@link ValueRef}. That is what lets the whole graph be
 * validated before anything runs and rendered as a graph while it runs.
 *
 * See docs/ideas/agent-graph-design-v2.md §1.2–§1.8.
 */

export type NodeId = string;

/** A JSON Schema document, kept opaque here and compiled by json-schema.ts. */
export type JsonSchema = Record<string, unknown>;

/** A plain JSON value — the right-hand side of a comparison condition. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * A prompt template.
 *
 * For now a plain string; `${ref}` interpolation of {@link ValueRef}s is a P2
 * concern. Typed as its own alias so the wiring layer can grow without a churn
 * of every node definition.
 */
export type Template = string;

/**
 * A reference to a value produced elsewhere in the run.
 *
 * Canonical, serializable form (the dotted `review.output.approved` seen in prose
 * is display shorthand for this). `node` omitted means the graph input; `path` is
 * a JSONPath into that node's validated output, where `$` is the whole value.
 */
export interface ValueRef {
  node?: NodeId;
  path: string;
}

/**
 * The declarative condition language for edge guards (§1.6).
 *
 * Deliberately small and serializable — no arbitrary predicates. Grow it only
 * when a real workflow needs an operator that is not here.
 */
export type Condition =
  | { eq: [ValueRef, JsonValue] }
  | { ne: [ValueRef, JsonValue] }
  | { gt: [ValueRef, number] }
  | { gte: [ValueRef, number] }
  | { lt: [ValueRef, number] }
  | { lte: [ValueRef, number] }
  | { exists: ValueRef }
  | { and: Condition[] }
  | { or: Condition[] }
  | { not: Condition };

/** Node-level validation beyond schema: a deterministic host gate (§1.5). */
export interface ValidationPolicy {
  /**
   * Shell command bound to the node's completion, run in the node's effective
   * cwd and authorized separately. Non-zero exit fails the node. This is the
   * only place a graph makes the host run a command — there is no action node.
   */
  gate?: string;
}

/** Bounded retry for a node that fails validation (§1.5). */
export interface RetryPolicy {
  maxAttempts: number;
}

/** Bound on a back-edge so a loop cannot run forever (§1.7). */
export interface LoopPolicy {
  maxIterations: number;
}

/** Runs a Pi subagent and returns a typed result. */
export interface AgentNode {
  type: "agent";
  agent: string;
  prompt: Template;
  input?: Record<string, ValueRef>;
  outputSchema?: JsonSchema;
  validation?: ValidationPolicy;
  retry?: RetryPolicy;
  resources?: string[];
}

/** Pauses the run until a person approves, rejects, edits, or supplies data. */
export interface HumanGateNode {
  type: "human_gate";
  prompt: Template;
  input?: Record<string, ValueRef>;
  outputSchema: JsonSchema;
}

/** Invokes a reusable saved graph as a node — the main composition mechanism. */
export interface SubgraphNode {
  type: "graph";
  graph: string;
  input?: Record<string, ValueRef>;
}

/** Adds a validated {@link GraphFragment} to the current run graph at runtime. */
export interface ExpandNode {
  type: "expand";
  /** Must resolve to a {@link GraphFragment} at runtime. */
  source: ValueRef;
  namespace?: string;
}

export type GraphNode = AgentNode | HumanGateNode | SubgraphNode | ExpandNode;

/** A dependency/dataflow edge, optionally guarded and optionally a bounded loop. */
export interface GraphEdge {
  from: NodeId;
  to: NodeId;
  /** When present, the edge only activates if this condition holds. */
  when?: Condition;
  /** When present, this edge may be a back-edge, bounded by `maxIterations`. */
  loop?: LoopPolicy;
}

/** A reusable graph, saved to disk or supplied inline. */
export interface AgentGraph {
  id?: string;
  name?: string;
  version?: number;
  /** Optional human-readable purpose shown only for live graph runs. */
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  nodes: Record<NodeId, GraphNode>;
  edges: GraphEdge[];
  outputs?: Record<string, ValueRef>;
}

/**
 * A fragment an expand node inserts into the running graph (§1.8).
 *
 * Same shape as a graph minus the top-level metadata/schemas: it is spliced into
 * an existing run graph, not run on its own.
 */
export interface GraphFragment {
  nodes: Record<NodeId, GraphNode>;
  edges: GraphEdge[];
  outputs?: Record<string, ValueRef>;
}

export const NODE_TYPES = ["agent", "human_gate", "graph", "expand"] as const;
export type NodeType = (typeof NODE_TYPES)[number];
