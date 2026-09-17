/**
 * value-ref.ts — resolve a {@link ValueRef} against a running graph.
 *
 * A ValueRef points either at the graph input (`node` omitted) or at a settled
 * node's output, then walks a small JSONPath into it. This is the one place that
 * turns the declarative wiring in the IR into an actual value, used both for a
 * node's typed inputs and for condition operands.
 *
 * Absence is a first-class result: an unknown node, an unsettled node, or a path
 * that does not exist all return {@link MISSING} rather than `undefined`, so the
 * caller can tell "the value is genuinely undefined" from "there is no value
 * there yet". Conditions treat MISSING as unsatisfied; input wiring omits it.
 */

import type { ValueRef } from "./ir.js";

/** Sentinel for "no value at this reference" — distinct from a real `undefined`. */
export const MISSING = Symbol("missing");
export type Missing = typeof MISSING;

export interface ResolutionContext {
  /** The graph's input value, for refs with no `node`. */
  input: unknown;
  /** Settled node outputs, parsed to JS values, keyed by node id. */
  outputs: ReadonlyMap<string, unknown>;
}

/** Resolve a ValueRef to its value, or {@link MISSING}. */
export function resolveValueRef(ref: ValueRef, ctx: ResolutionContext): unknown | Missing {
  let base: unknown;
  if (ref.node === undefined) {
    base = ctx.input;
  } else if (ctx.outputs.has(ref.node)) {
    base = ctx.outputs.get(ref.node);
  } else {
    return MISSING;
  }
  return evalPath(ref.path, base);
}

/**
 * Evaluate a minimal JSONPath: `$`, `$.field`, `$.a.b`, `$[0]`, `$["k"]`.
 *
 * Not a full JSONPath implementation — deliberately just member and index
 * access, which is all the wiring needs. An unparseable path or a step off the
 * end of the data returns {@link MISSING}.
 */
export function evalPath(path: string, root: unknown): unknown | Missing {
  if (!path.startsWith("$")) return MISSING;
  if (path === "$") return root;
  const tokens = tokenize(path.slice(1));
  if (tokens === undefined) return MISSING;
  let current: unknown = root;
  for (const token of tokens) {
    if (current === null || current === undefined) return MISSING;
    if (typeof token === "number") {
      if (!Array.isArray(current) || token < 0 || token >= current.length) return MISSING;
      current = current[token];
    } else {
      if (typeof current !== "object" || Array.isArray(current)) return MISSING;
      if (!Object.hasOwn(current as object, token)) return MISSING;
      current = (current as Record<string, unknown>)[token];
    }
  }
  return current;
}

const STEP = /^(?:\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\["([^"]*)"\])/;

/** Split `.a.b[0]["k"]` into `["a","b",0,"k"]`, or undefined if malformed. */
function tokenize(rest: string): (string | number)[] | undefined {
  const tokens: (string | number)[] = [];
  let remaining = rest;
  while (remaining.length > 0) {
    const match = STEP.exec(remaining);
    if (match === null) return undefined;
    if (match[1] !== undefined) tokens.push(match[1]);
    else if (match[2] !== undefined) tokens.push(Number(match[2]));
    else tokens.push(match[3] ?? "");
    remaining = remaining.slice(match[0].length);
  }
  return tokens;
}
