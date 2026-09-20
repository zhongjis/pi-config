import type { GraphFragment, NodeId } from "./ir.js";
import { validateFragment } from "./validate.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new TypeError("Expected a fragment object");
  return value;
}

function rewriteRef(value: unknown, rename: (id: unknown) => unknown): unknown {
  const ref = object(value);
  return ref.node === undefined ? ref : { ...ref, node: rename(ref.node) };
}

function rewriteCondition(value: unknown, rename: (id: unknown) => unknown): unknown {
  const condition = object(value);
  return Object.fromEntries(Object.entries(condition).map(([op, operand]) => {
    if ((op === "and" || op === "or") && Array.isArray(operand)) return [op, operand.map(sub => rewriteCondition(sub, rename))];
    if (op === "not") return [op, rewriteCondition(operand, rename)];
    if (op === "exists") return [op, rewriteRef(operand, rename)];
    if (["eq", "ne", "gt", "gte", "lt", "lte"].includes(op) && Array.isArray(operand)) {
      return [op, operand.map((part, index) => index === 0 ? rewriteRef(part, rename) : part)];
    }
    return [op, operand];
  }));
}

function rewriteNode(value: unknown, rename: (id: unknown) => unknown): unknown {
  const node = object(value);
  if (node.type === "bounded_feedback") return node;
  if (node.type === "expand") return { ...node, source: rewriteRef(node.source, rename) };
  return { ...node,
    ...(node.type === "fanout" ? { items: rewriteRef(node.items, rename) } : {}),
    ...(node.input === undefined ? {} : { input: Object.fromEntries(Object.entries(object(node.input)).map(([key, ref]) => [key, rewriteRef(ref, rename)])) }),
  };
}

/** Place internal IDs before validation: source IDs may collide with the live graph. */
export function namespaceFragment(fragment: GraphFragment, namespace: string | undefined): GraphFragment;
export function namespaceFragment(fragment: unknown, namespace: string | undefined): unknown;
export function namespaceFragment(fragment: unknown, namespace: string | undefined): unknown {
  if (namespace === undefined) return fragment;
  const source = object(fragment);
  const nodes = object(source.nodes);
  const internal = new Set(Object.keys(nodes));
  const rename = (id: unknown): unknown => typeof id === "string" && internal.has(id) ? `${namespace}:${id}` : id;
  if (!Array.isArray(source.edges)) throw new TypeError("Fragment edges must be an array");
  return {
    nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [`${namespace}:${id}`, rewriteNode(node, rename)])),
    edges: source.edges.map(value => {
      const edge = object(value);
      return { ...edge, from: rename(edge.from), to: rename(edge.to),
        ...(edge.when === undefined ? {} : { when: rewriteCondition(edge.when, rename) }),
      };
    }),
    ...(source.outputs === undefined ? {} : { outputs: Object.fromEntries(Object.entries(object(source.outputs)).map(([key, ref]) => [key, rewriteRef(ref, rename)])) }),
  };
}

/** Narrow only after structural and effective-identity validation. */
export function parseFragment(value: unknown, existingIds: Iterable<NodeId>): GraphFragment {
  function validate(fragment: unknown): asserts fragment is GraphFragment {
    const result = validateFragment(fragment, existingIds);
    if (!result.ok) throw new TypeError(result.errors.join("; "));
  }
  validate(value);
  return value;
}
