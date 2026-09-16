/**
 * json-schema.ts — validating a script-supplied JSON Schema.
 *
 * `agent(prompt, { schema })` hands us a raw JSON Schema written by a model, to
 * be used two ways: as a tool's `parameters` (so the provider fills the fields)
 * and as the check that decides whether what came back is usable.
 *
 * ## Which typebox
 *
 * **`typebox`, not `@sinclair/typebox`.** They are different packages and both
 * are installed here. `@sinclair/typebox` (0.34) dispatches on a `Kind` symbol
 * that a schema arriving over the wire does not carry, so `Value.Check` throws
 * `Unknown type` on a plain JSON Schema — and `Type.Unsafe` does not help, it
 * stamps a `Kind` that is not registered. `typebox` v1 is a standards JSON
 * Schema validator and takes the schema as-is. It is also the package pi itself
 * types `ToolDefinition.parameters` against, so the same schema object serves
 * both roles with no conversion.
 *
 * ## Why we validate at all
 *
 * Nothing in pi checks a tool call's arguments against the tool's `parameters`.
 * `validateToolCall`/`validateToolArguments` exist in `pi-ai` but are never
 * called from either shipped package, so a schema on a tool is a *prompt to the
 * provider*, not an enforcement point. Every guarantee the script gets about
 * the shape of its result is made here.
 *
 * Pure and pi-free on purpose, so `runtime.ts` can import it without dragging
 * sessions and models into the runtime's tests.
 */

import { Check, Errors } from "typebox/value";

/** Largest schema we will accept, serialized. */
const MAX_SCHEMA_BYTES = 64 * 1024;

/** How many validation errors are quoted back to the model. */
const MAX_REPORTED_ERRORS = 5;

export interface CompiledSchema {
  /**
   * The schema as given — used as the journal key and for local `check`.
   * NOT sent to the provider (constraint keywords break Anthropic's validator).
   */
  readonly schema: Record<string, unknown>;
  /**
   * A deep copy of `schema` with all constraint/format keywords stripped.
   * This is what the tool sends as `parameters` so every provider accepts it.
   */
  readonly providerSchema: Record<string, unknown>;
  /** `true`, or a human-readable account of what is wrong. */
  check(value: unknown): true | string;
}

export type SchemaCompilation =
  | { ok: true; compiled: CompiledSchema }
  | { ok: false; message: string };

/**
 * Turn a script-supplied schema into something we can check against.
 *
 * Rejects up front rather than at the first tool call. A schema whose root is
 * not an object cannot be a tool's input schema at all, so it would break every
 * request the child makes rather than just the last one — and the author should
 * hear about that before a model is paid to discover it.
 */
export function compileJsonSchema(schema: unknown): SchemaCompilation {
  return compileSchema(schema, "agent() opts.schema", true);
}

export function compileInputSchema(schema: unknown): SchemaCompilation {
  return compileSchema(schema, "meta.inputSchema", false);
}

function compileSchema(schema: unknown, label: string, objectRoot: boolean): SchemaCompilation {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return { ok: false, message: `${label} must be a JSON Schema object.` };
  }
  const root = schema as Record<string, unknown>;
  if (objectRoot && root.type !== "object") {
    return {
      ok: false,
      message:
        'agent() opts.schema must have `type: "object"` at its root — it becomes the tool\'s input schema, '
        + "and a non-object root is not something a model can be asked to fill.",
    };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(root);
  } catch {
    return { ok: false, message: `${label} must be JSON-serializable.` };
  }
  if (serialized.length > MAX_SCHEMA_BYTES) {
    return {
      ok: false,
      message: `${label} is too large (${serialized.length} bytes; the limit is ${MAX_SCHEMA_BYTES}).`,
    };
  }

  // Smoke-tested here so a schema the validator cannot walk fails at the call
  // that wrote it, with the schema in hand, rather than inside a child's tool
  // handler where the only symptom is an agent that never returns.
  try {
    Check(root, {});
  } catch (error) {
    return {
      ok: false,
      message: `${label} is not a schema this runtime can validate: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return { ok: true, compiled: { schema: root, providerSchema: stripUnsupported(root), check: value => checkAgainst(root, value) } };
}

function checkAgainst(schema: Record<string, unknown>, value: unknown): true | string {
  let valid: boolean;
  try {
    valid = Check(schema, value);
  } catch (error) {
    // Reported rather than thrown: a schema that compiled but trips on a
    // particular value must fail that call, not the run.
    return `the value could not be validated: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (valid) return true;

  const reported: string[] = [];
  try {
    for (const error of Errors(schema, value)) {
      // `instancePath` is JSON Pointer (`/a/b`); the model wrote the schema in
      // JavaScript, so it reads `$.a.b` far more easily.
      const path = String(error.instancePath ?? "");
      const where = path === "" ? "$" : `$${path.replace(/\//g, ".")}`;
      reported.push(`${where}: ${error.message}`);
      if (reported.length >= MAX_REPORTED_ERRORS) break;
    }
  } catch {
    // Errors() can trip where Check() merely returned false. A vaguer message
    // still names the right problem.
    return reported.join("; ") || "the value does not match the required schema";
  }
  return reported.length > 0 ? reported.join("; ") : "the value does not match the required schema";
}

// ─── Provider-schema stripping ─────────────────────────────────────────────────────────

/**
 * Keyword categories Anthropic's tool-schema validator rejects.
 * Stripped from `providerSchema`; kept in `schema` for local `check`.
 */
const PROVIDER_DENYLIST = new Set([
  // arrays
  "minItems", "maxItems", "uniqueItems", "minContains", "maxContains",
  // strings
  "minLength", "maxLength", "pattern", "format",
  // numbers
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  // objects
  "minProperties", "maxProperties",
]);

/** Known schema-bearing keys that hold an object-of-subschemas (recurse each value). */
const OBJECT_OF_SCHEMAS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

/** Known schema-bearing keys that hold a single subschema (recurse if plain object). */
const SINGLE_SCHEMA = new Set([
  "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else",
]);

/** Known schema-bearing keys that hold an array-of-subschemas (map each element). */
const ARRAY_OF_SCHEMAS = new Set(["prefixItems", "anyOf", "allOf", "oneOf"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Return a deep copy of `node` with every constraint/format keyword removed at
 * every schema position. Structural keywords and literal data are preserved.
 * Input is never mutated.
 */
export function stripUnsupported(node: unknown): Record<string, unknown> {
  if (!isPlainObject(node)) return {} as Record<string, unknown>;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (PROVIDER_DENYLIST.has(key)) continue;

    if (OBJECT_OF_SCHEMAS.has(key) && isPlainObject(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        mapped[k] = isPlainObject(v) ? stripUnsupported(v) : v;
      }
      result[key] = mapped;
    } else if (key === "items") {
      // items is either an array-of-schemas or a single schema
      if (Array.isArray(value)) {
        result[key] = value.map(el => isPlainObject(el) ? stripUnsupported(el) : el);
      } else if (isPlainObject(value)) {
        result[key] = stripUnsupported(value);
      } else {
        result[key] = value;
      }
    } else if (ARRAY_OF_SCHEMAS.has(key)) {
      if (Array.isArray(value)) {
        result[key] = value.map(el => isPlainObject(el) ? stripUnsupported(el) : el);
      } else {
        result[key] = value;
      }
    } else if (SINGLE_SCHEMA.has(key)) {
      result[key] = isPlainObject(value) ? stripUnsupported(value) : value;
    } else {
      result[key] = value;
    }
  }
  return result;
}
