import type { AgentNode, FanoutNode, JsonValue } from "./ir.js";
import { compileJsonSchema } from "./json-schema.js";
import { evalPath, MISSING, type ResolutionContext, resolveValueRef } from "./value-ref.js";

export interface FanoutChild {
  readonly nodeId: string;
  readonly item: JsonValue;
}

export interface PreparedFanoutItem {
  readonly item: JsonValue;
  readonly node: AgentNode;
}

// Fanout items cross a durable JSON boundary; reject cycles and lossy values.
function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const valid = Object.values(value).every(child => isJsonValue(child, ancestors));
  ancestors.delete(value);
  return valid;
}

/** Prepare the complete batch without touching topology or spawning any child. */
export function prepareFanout(node: FanoutNode, context: ResolutionContext):
  { readonly ok: true; readonly items: readonly PreparedFanoutItem[] } | { readonly ok: false; readonly error: string } {
  const items: unknown = resolveValueRef(node.items, context);
  if (!Array.isArray(items)) return { ok: false, error: "items must resolve to an array" };
  const schema = compileJsonSchema(node.itemSchema);
  if (!schema.ok) return { ok: false, error: schema.message };
  const prepared: PreparedFanoutItem[] = [];
  for (const [index, item] of items.entries()) {
    if (!isJsonValue(item)) return { ok: false, error: `items[${index}] must be JSON-serializable` };
    const check = schema.compiled.check(item);
    if (check !== true) return { ok: false, error: `items[${index}]: ${check}` };
    const selector = evalPath(node.dispatch.path, item);
    if ((typeof selector !== "string" && typeof selector !== "number" && typeof selector !== "boolean") ||
        !Object.hasOwn(node.dispatch.cases, String(selector))) {
      return { ok: false, error: `items[${index}]: dispatch miss at ${node.dispatch.path}` };
    }
    // Interpolate once: placeholders inside item data are literal child input,
    // not another template to resolve against the parent's conversation or state.
    const prompt = node.prompt.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (whole, name: string) => {
      if (name === "item") return JSON.stringify(item);
      const ref = node.input?.[name];
      if (ref === undefined) return whole;
      const value = resolveValueRef(ref, context);
      return value === MISSING ? whole : typeof value === "string" ? value : JSON.stringify(value);
    });
    prepared.push({ item, node: {
      type: "agent", agent: node.dispatch.cases[String(selector)], prompt,
      ...(node.outputSchema !== undefined ? { outputSchema: node.outputSchema } : {}),
    } });
  }
  return { ok: true, items: prepared };
}
