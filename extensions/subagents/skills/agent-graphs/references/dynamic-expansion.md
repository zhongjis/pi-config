# Dynamic Expansion

Use `fanout` to turn a validated task array into visible agent nodes while keeping collection and control flow inside the graph. Use legacy `expand` only when an upstream node must provide a complete `GraphFragment` with model-authored topology.

## When to use dynamic expansion

Use `fanout` when the number of independent tasks is known only at runtime and every task has the same item/output contract. It creates only requested children, dispatches each item through an author-declared agent table, and collects all outcomes.

Keep static `agent` nodes when the work set is fixed. Use separate fanouts for separate evaluation rounds. A loop target cannot reach a fanout or bounded-feedback barrier through normal edges (directly or transitively, including after expansion), and any insertion that would exceed the 500-node effective-run ceiling fails before insertion.

## Typed task input

A fanout node has this contract:

```ts
interface FanoutNode {
  type: "fanout";
  items: ValueRef;
  itemSchema: JsonSchema; // object root
  dispatch: {
    path: string;                  // JSONPath relative to one item
    cases: Record<string, string>; // value -> agent selector; no default
  };
  prompt: Template;
  input?: Record<string, ValueRef>;
  outputSchema?: JsonSchema;       // each child's structured output
  phase?: { index: number; title: string };
}
```

Validate the caller input and repeat its item contract on the fanout. `${item}` expands to the complete JSON item; every other prompt placeholder must be declared in `input`.

```jsonc
{
  "inputSchema": {
    "type": "object",
    "properties": {
      "request": { "type": "string" },
      "tasks": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "source": { "type": "string", "enum": ["project", "upstream"] },
            "question": { "type": "string" },
            "reason": { "type": "string" }
          },
          "required": ["source", "question"]
        }
      }
    },
    "required": ["request", "tasks"]
  },
  "nodes": {
    "research-round-1": {
      "type": "fanout",
      "items": { "path": "$.tasks" },
      "itemSchema": {
        "type": "object",
        "properties": {
          "source": { "type": "string", "enum": ["project", "upstream"] },
          "question": { "type": "string" },
          "reason": { "type": "string" }
        },
        "required": ["source", "question"]
      },
      "dispatch": {
        "path": "$.source",
        "cases": { "project": "chengfeng", "upstream": "wenchang" }
      },
      "prompt": "Request: ${request}\nTask: ${item}\nReturn validated JSON only.",
      "input": { "request": { "path": "$.request" } },
      "outputSchema": {
        "type": "object",
        "properties": {
          "evidence": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["evidence"]
      },
      "phase": { "index": 0, "title": "Round 1/2" }
    }
  }
}
```

The runtime validates the complete item array, every item, every dispatch value, and all generated IDs before creating a child. A non-array, schema mismatch, missing dispatch case, ID collision, or node-ceiling overflow fails atomically.

## Awaited completion

A fanout is a running barrier. It inserts one ordinary agent child per item, then settles only after every owned child is terminal. Generated children use normal delegation, concurrency, resource, structured-output, control, and fresh-Subagent behavior.

Downstream nodes therefore read a complete all-settled collection. They never need polling, detached tasks, or hidden conversation continuation.

## Per-round namespaces

Generated IDs are deterministic: `<fanout-id>:item:<index>`. Give each round a distinct fanout node ID, such as `research-round-1` and `research-round-2`; their generated IDs cannot collide.

Set phase metadata on each fanout so generated rows appear in the intended monitor group:

| Fanout node | Generated IDs | Phase |
|---|---|---|
| `research-round-1` | `research-round-1:item:<index>` | `{ "index": 0, "title": "Round 1/2" }` |
| `research-round-2` | `research-round-2:item:<index>` | `{ "index": 2, "title": "Round 2/2" }` |

Phase rounds and execution attempts are independent. A retry or loop rerun increments `attempt`; it does not create another evidence round.

## Bounded evaluation loops

Bound adaptive work with explicit fanout/evaluator pairs rather than a back-edge into one fanout:

```jsonc
"edges": [
  { "from": "research-round-1", "to": "evaluate-round-1" },
  {
    "from": "evaluate-round-1",
    "to": "done",
    "when": { "eq": [{ "node": "evaluate-round-1", "path": "$.sufficient" }, true] }
  },
  {
    "from": "evaluate-round-1",
    "to": "research-round-2",
    "when": { "eq": [{ "node": "evaluate-round-1", "path": "$.sufficient" }, false] }
  },
  { "from": "research-round-2", "to": "evaluate-round-2" },
  { "from": "evaluate-round-2", "to": "done" }
]
```

Each evaluator should return a narrow typed decision:

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "sufficient": { "type": "boolean" },
    "gaps": { "type": "array", "items": { "type": "string" } },
    "tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "source": { "type": "string" },
          "question": { "type": "string" },
          "reason": { "type": "string" }
        },
        "required": ["source", "question", "reason"]
      }
    }
  },
  "required": ["sufficient", "gaps", "tasks"]
}
```

Wire the second fanout's `items` to `evaluate-round-1.tasks`. On the final evaluator, require an empty `tasks` array (for example, `maxItems: 0`) so the graph cannot imply an unavailable third round.

## Output and failure collection

A completed fanout returns results in input order, not completion order:

```ts
interface FanoutResult {
  results: Array<{
    nodeId: string;
    index: number;
    item: JsonValue;
    status: "completed" | "failed" | "skipped";
    attempt: number;
    output?: unknown;
    error?: string;
  }>;
}
```

Read the collection with a `ValueRef`:

```jsonc
"input": {
  "evidence": { "node": "research-round-1", "path": "$.results" }
}
```

A failed or skipped child remains visible and is copied into the collection; it does not fail its fanout parent or siblings. Materialization errors fail the fanout parent because no valid collection exists. Evaluators and synthesizers must inspect `status`, `output`, and `error`, preserve successful evidence, and convert missing evidence into gaps or unknowns.
