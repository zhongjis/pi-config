/**
 * condition.ts — evaluate a declarative edge {@link Condition}.
 *
 * The condition language is small and serializable (no arbitrary predicates), so
 * this is a total function over the IR: every shape is handled and there is no
 * `eval`. It runs against the same {@link ResolutionContext} the wiring uses, so
 * an edge guard sees exactly the node outputs a downstream input would.
 *
 * MISSING is unsatisfied. A reference that has no value makes a comparison false
 * (and `exists` false); `ne` against a missing value is true, matching "this is
 * not equal to the literal because there is nothing there". This keeps a guard on
 * an unproduced output from silently activating an edge.
 */

import type { Condition, JsonValue, ValueRef } from "./ir.js";
import { MISSING, type ResolutionContext, resolveValueRef } from "./value-ref.js";

export function evaluateCondition(condition: Condition, ctx: ResolutionContext): boolean {
  if ("eq" in condition) {
    const value = resolveValueRef(condition.eq[0], ctx);
    return value !== MISSING && deepEqual(value, condition.eq[1]);
  }
  if ("ne" in condition) {
    const value = resolveValueRef(condition.ne[0], ctx);
    return value === MISSING || !deepEqual(value, condition.ne[1]);
  }
  if ("gt" in condition) return compareNumber(condition.gt, ctx, (a, b) => a > b);
  if ("gte" in condition) return compareNumber(condition.gte, ctx, (a, b) => a >= b);
  if ("lt" in condition) return compareNumber(condition.lt, ctx, (a, b) => a < b);
  if ("lte" in condition) return compareNumber(condition.lte, ctx, (a, b) => a <= b);
  if ("exists" in condition) {
    const value = resolveValueRef(condition.exists, ctx);
    return value !== MISSING && value !== undefined && value !== null;
  }
  if ("and" in condition) return condition.and.every(sub => evaluateCondition(sub, ctx));
  if ("or" in condition) return condition.or.some(sub => evaluateCondition(sub, ctx));
  return !evaluateCondition(condition.not, ctx);
}

function compareNumber(
  operand: [ValueRef, number],
  ctx: ResolutionContext,
  cmp: (a: number, b: number) => boolean,
): boolean {
  const value = resolveValueRef(operand[0], ctx);
  return typeof value === "number" && cmp(value, operand[1]);
}

/** Structural equality for JSON values — the RHS of eq/ne is always JSON. */
function deepEqual(a: unknown, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i] as JsonValue));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every(
      key => Object.hasOwn(b as object, key) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, JsonValue>)[key]),
    );
  }
  return false;
}
