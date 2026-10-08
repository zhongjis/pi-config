# Authoring agent graphs

Read this before authoring or editing any graph, inline included. Callers follow [SKILL.md](../SKILL.md). The tool description owns when to call `agent_graph`.

## The graph is the machine

A graph is data. The runtime validates it before anything runs. The graph owns rules, identity, and transitions. Agents do generative work inside one state. The next step follows from validated output.

### Determinism

- **Rules live in the machine.** When typed data can decide a rule, enforce it with `enum` / `const` / `if`–`then`, a condition, a `semanticPolicy`, or `validation.gate`. A prompt may restate the rule; the machine enforces it.
- **Branches are typed events.** A branching node emits one enum field. Each value you want to take gets one guarded edge. Prompts describe the state's work; edges carry order.
- **Side effects sit behind a decision.** Reach a node that writes, sends, or pushes only through a `decision_gate` edge on a `true` answer or a passing `validation.gate`.
- **Outcome follows evidence.** Couple outcome fields to evidence with `if` / `then` so only the matching status validates. Read values the machine already holds, such as a fanout child's `item`, instead of asking an agent to echo them.
- **The machine hands out identity.** Parallel children see only `${item}`. Have one upstream node assign each item a `taskId`, prefix derived IDs with it, and constrain both with `pattern`. When items carry unique IDs, `bounded_feedback`'s exact-repeat check never fires, so termination relies on the evaluator's transition rule and hard bounds.
- **Validate at the owning state.** Reject bad output in the node that produced it. StructuredOutput rejection lets that agent correct itself. A downstream node cannot repair upstream data, and a node retry reruns the same prompt.

## Worked example

Implement → review (`event`: `approve` | `revise` | `escalate`) → fix loop → `decision_gate` → externally visible side effect. `fix` reads the reviewer's validated `findings`, not its prose. Outcome comes from `review`, which runs on every path past `implement`, including a capped loop's last verdict. `escalate` has no successor: the judge's outcome is the terminal verdict. Selectors must be permitted by the caller's mode.

```json
{
  "name": "review-fix",
  "description": "Implement, review, and approve before a side effect",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["task"],
    "properties": { "task": { "type": "string", "minLength": 1 } }
  },
  "nodes": {
    "implement": {
      "type": "agent",
      "name": "Implement",
      "agent": "jintong",
      "prompt": "Implement this task. Return JSON only.\n${task}",
      "input": { "task": { "path": "$.task" } },
      "validation": { "gate": "git diff --check" },
      "outputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["summary"],
        "properties": { "summary": { "type": "string" } }
      }
    },
    "review": {
      "type": "agent",
      "agent": "yanluo",
      "prompt": "Review the workspace for this task.\n${task}\nReturn event approve, revise, or escalate, concrete findings, and an outcome envelope.",
      "input": { "task": { "path": "$.task" } },
      "outputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["event", "findings", "outcome"],
        "properties": {
          "event": { "enum": ["approve", "revise", "escalate"] },
          "findings": { "type": "array", "items": { "type": "string" } },
          "outcome": {
            "type": "object",
            "additionalProperties": false,
            "required": ["status"],
            "properties": {
              "status": { "enum": ["succeeded", "partial", "failed"] },
              "reason": { "type": "string", "pattern": "\\S" }
            },
            "allOf": [
              { "if": { "properties": { "status": { "const": "succeeded" } }, "required": ["status"] }, "then": { "not": { "required": ["reason"] } } },
              { "if": { "properties": { "status": { "enum": ["partial", "failed"] } }, "required": ["status"] }, "then": { "required": ["reason"] } }
            ]
          }
        }
      }
    },
    "fix": {
      "type": "agent",
      "name": "Fix findings",
      "agent": "jintong",
      "prompt": "Fix these review findings for the task.\nTask: ${task}\nFindings: ${findings}",
      "input": { "task": { "path": "$.task" }, "findings": { "node": "review", "path": "$.findings" } },
      "validation": { "gate": "git diff --check" }
    },
    "approve": {
      "type": "decision_gate",
      "name": "Ship decision",
      "state": { "task": { "path": "$.task" }, "review": { "node": "review", "path": "$" } },
      "questions": {
        "ship": {
          "type": "bool",
          "instructions": "Decide whether the reviewed change is safe to commit and push.",
          "criteria": { "true": "The review approved the change and nothing blocks shipping.", "false": "Any open finding or doubt blocks shipping." }
        }
      }
    },
    "ship": {
      "type": "agent",
      "name": "Ship",
      "agent": "jintong",
      "prompt": "Commit the reviewed change and push the branch. Skip any step already done."
    }
  },
  "edges": [
    { "from": "implement", "to": "review" },
    { "from": "review", "to": "approve", "when": { "eq": [{ "node": "review", "path": "$.event" }, "approve"] } },
    { "from": "review", "to": "fix", "when": { "eq": [{ "node": "review", "path": "$.event" }, "revise"] } },
    { "from": "fix", "to": "review", "loop": { "maxIterations": 3 } },
    { "from": "approve", "to": "ship", "when": { "eq": [{ "node": "approve", "path": "$.answers.ship.value" }, true] } }
  ],
  "outputs": {
    "$agentGraphOutcome": { "node": "review", "path": "$.outcome" },
    "event": { "node": "review", "path": "$.event" }
  }
}
```

## Graph shape

```jsonc
{
  "name": "optional",
  "id": "optional",
  "description": "Shown in the monitor",
  "inputSchema": { "type": "object" },
  "nodes": { "<id>": { } },
  "edges": [ { "from": "<id>", "to": "<id>", "when": { }, "loop": { "maxIterations": 3 } } ],
  "outputs": { "<name>": { "node": "<id>", "path": "$.field" } }
}
```

- `name`, `id` — optional strings.
- `description` — optional; shown for the live run.
- `inputSchema` — documents `input`. A direct `agent_graph` call does not enforce it. See [SKILL.md](../SKILL.md).
- `outputSchema` — compiled for validity only, never enforced. Omit it.
- `semanticPolicy` — `context-gather-v1` or `deep-research-v1`. `context-gather-v1` requires structured `plan`, `research` (`bounded_feedback`), and `synthesize` nodes and is reserved for `context-gather`. `deep-research-v1` requires `planning` (`graph` returning `{parts, tasks, seed, approved}`), `research` (`bounded_feedback`), and `synthesize` (`agent`) and is reserved for `deep-research`; see [bounded-feedback.md](bounded-feedback.md#deep-research-v1).
- `nodes`, `edges`, `outputs` — the graph. Node ids are unique. `outputs` values are ValueRefs.

There is no shell or action node. A deterministic check is `validation.gate` on the node that owns it.

## Node reference

Spell field names exactly. Unknown keys are ignored, except on `decision_gate` and `bounded_feedback`, which reject them. A misspelled `outputschema` yields an untyped node.

Optional `name` labels the node's monitor row; without it the row shows the node key. It is presentation only and may duplicate.

- **agent** — runs one subagent. See [Agent nodes](#agent-nodes).
- **decision_gate** — answers typed questions over resolved state. Never takes an agent selector. See [Decision gates](#decision-gates).
- **graph** — runs a saved graph by name, not an inline graph. This node's output is that graph's `outputs`. Delegation preflight recurses into a saved graph it can load. An unresolvable name fails when the node runs.
- **fanout** — turns a validated runtime item array into ordinary agent children, awaits every child, and returns input-ordered all-settled results. Read [dynamic-expansion.md](dynamic-expansion.md).
- **expand** — splices a runtime `GraphFragment` (`{ nodes, edges, outputs? }`) into the live graph. `namespace` isolates inserted ids. A fragment MUST NOT contain `fanout` or `bounded_feedback`. Read [dynamic-expansion.md](dynamic-expansion.md).
- **bounded_feedback** — fixed work and evaluator templates, with required bounds. Read [bounded-feedback.md](bounded-feedback.md).

### Decision gates

[ir.ts](../../../src/graph/ir.ts) (`DecisionGateNode`, `ClassifierQuestion`) and [decision-gate.ts](../../../src/graph/decision-gate.ts) own the shapes.

- `state` — ValueRefs resolved into the decision context. Optional `name` labels the row.
- `questions` — keyed by answer ID. Each has `type`, nonempty `instructions`, and `criteria`: `bool` takes `{ "true", "false" }`; `choice` maps at least two labels to descriptions; `score` lists at least two level descriptions.
- `minConfidence` — optional, in [0, 1]. Defaults to the `decisionGateMinConfidence` setting.
- Output is `{ "answers": { <id>: { "value", "confidence" } }, "decidedBy" }`. Conditions read `$.answers.<id>.value`.

The decider chain is the `subagents.decision_gate` key of `tool_models.json` ([defaults](../../../../lib/tool-model-defaults.ts)), walked in order ([node-host-adapter.ts](../../../src/graph/node-host-adapter.ts) `decide`). A classifier model classifies; any other entry runs the runtime-internal graph classifier agent on that model. An unavailable or failed entry advances to the next; the first valid answer is final. If any answer falls below `minConfidence`, or the chain is exhausted, the gate escalates to the invoking orchestrator ([SKILL.md](../SKILL.md#4-escalations)). With no agent selector, a gate adds nothing to delegation preflight.

```jsonc
{ "type": "decision_gate", "state": { "plan": { "node": "plan", "path": "$" } },
  "questions": { "proceed": { "type": "bool", "instructions": "Is the plan ready to execute?",
    "criteria": { "true": "Every step is concrete and in scope.", "false": "A step is vague or out of scope." } } } }
```

## Agent nodes

```jsonc
{ "type": "agent", "agent": "jintong", "prompt": "Fix ${task}",
  "input": { "task": { "path": "$.task" } },
  "outputSchema": { "type": "object", "properties": { "ok": { "type": "boolean" } }, "required": ["ok"], "additionalProperties": false },
  "validation": { "gate": "git diff --check" }, "retry": { "maxAttempts": 2 } }
```

- Without `outputSchema` the output is raw text. Read it with path `$`. Conditions cannot branch on prose.
- No `model`, `effort`, or `thinking` fields. Model and thinking come only from the agent's frontmatter. Saved graphs MUST NOT set them.
- `retry.maxAttempts` is total executions (`2` = one retry). Default is 1. Retries follow any node failure: agent error, schema failure, or gate failure. A schema mismatch first gets an in-session StructuredOutput repair. A retry is not a blind re-roll: an `agent` retry prompt appends `Previous attempt <n> failed:` with the last 2000 characters of the failure, including a failed gate's stdout/stderr. A restored execution uses the original prompt.
- `validation.gate` is a shell command in the child's effective cwd. A non-zero exit fails the node.
- `resources` has no effect through `agent_graph`: the tool sets no capacities, and an unset capacity is unlimited. Omit `resources`.

## Wiring

A ValueRef reads a value: `{ "node": "<id>", "path": "$.field" }`. Omit `node` to read graph `input`. `path` is `$`, `$.a.b`, `$.arr[0]`, `$[0]`, or `$["key"]`.

`${name}` in a prompt resolves only from that node's own `input` map. An unmapped placeholder is a validation error. A string inserts raw; any other value inserts `JSON.stringify`. A value missing at runtime leaves the literal `${name}`.

Reserved placeholders: `${item}` in a fanout, `${feedback}` in a `bounded_feedback` evaluator. Do not map those names in `input`.

Conditions are data, not code:

```jsonc
{ "eq": [ { "node": "review", "path": "$.event" }, "approve" ] }
```

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `exists`, `and`, `or`, `not`. Numeric ops need a number; a non-number is unsatisfied. A missing value is unsatisfied, except `ne`, which holds. `exists` is false for a missing value, `undefined`, or `null`.

Validation rejects a `when` path that provably cannot exist: a closed object schema (`additionalProperties: false`, no combinators) lacks the property, or the path descends below a scalar. A guard typo such as `$.verdcit` is a validation error, not a silent skip. `decision_gate` paths check against the output derived from its questions, so `$.answers.<id>.value` must name a declared question; input paths check against a closed `inputSchema`. Open, combinator, or missing schemas never error, and node `input` and `outputs` ValueRefs are not path-checked.

## Execution

A node runs when every forward (non-`loop`) predecessor has settled and at least one incoming edge is active — its source completed and its `when` holds. That is an OR-join. If every incoming edge settled and none activated, the node is skipped. A node with no incoming edges runs immediately.

A failed node activates no outgoing edges, so its dependents skip. Any failed node not collected by a fanout or `bounded_feedback` makes the run's execution status `failed`. Fanout and feedback child failures are collected evidence instead.

Default concurrency is 8 parallel nodes. Ceilings: 500 effective nodes, 1000 node runs, nested graph depth 32.

## Loops

An edge with `loop: { maxIterations: N }` may re-enter an already-run node. Put `loop` on the back edge into the judge (`fix → review`). The cap stops only that edge. After the last re-entry, the final `fix` output goes unreviewed, a guarded successor such as `done` is skipped, and the run still completes. Declare `$agentGraphOutcome` from the judge so a capped run reports its last verdict.

A `loop` on `review → fix` validates yet skips `fix`. A loop target MUST NOT reach a `fanout` or `bounded_feedback` over normal edges, including after expansion.

```jsonc
"edges": [
  { "from": "implement", "to": "review" },
  { "from": "review", "to": "done", "when": { "eq": [ { "node": "review", "path": "$.approved" }, true ] } },
  { "from": "review", "to": "fix", "when": { "eq": [ { "node": "review", "path": "$.approved" }, false ] } },
  { "from": "fix", "to": "review", "loop": { "maxIterations": 3 } }
]
```

## Declaring the run outcome

Declare objective outcome — independent of execution success — with a reserved output named `$agentGraphOutcome`:

```jsonc
"outputs": { "$agentGraphOutcome": { "node": "synthesize", "path": "$.outcome" } }
```

The source returns `{ "status": "succeeded" }` or `{ "status": "partial" | "failed", "reason": "<why>" }`. The runtime strips this key from the returned value and surfaces it as Outcome (`succeeded` | `partial: reason` | `failed: reason`). Omit it and a completed run shows `Completed`. A malformed envelope is ignored and never fails an already-completed run.

The envelope is exact: `succeeded` carries no other key, and `partial` / `failed` carry only a nonblank `reason`. Match the schema so a wrong envelope is rejected in-session:

```jsonc
"outcome": { "type": "object", "additionalProperties": false, "required": ["status"],
  "properties": { "status": { "enum": ["succeeded", "partial", "failed"] }, "reason": { "type": "string", "pattern": "\\S" } },
  "allOf": [
    { "if": { "properties": { "status": { "const": "succeeded" } }, "required": ["status"] }, "then": { "not": { "required": ["reason"] } } },
    { "if": { "properties": { "status": { "enum": ["partial", "failed"] } }, "required": ["status"] }, "then": { "required": ["reason"] } }
  ] }
```

A skipped source yields no envelope. Read the outcome from a node that runs on every path you need a verdict for. For a review/fix loop, that node is the judge.

## Patterns

**Typed-event branching.** One enum, one guarded edge per value:

```jsonc
"outputSchema": { "type": "object", "required": ["event"], "additionalProperties": false,
  "properties": { "event": { "enum": ["approve", "revise", "escalate"] } } }
```

**Review/fix loop.** Back edge `fix → review` carries `loop`. See [Loops](#loops).

**Decision before side effects.** A `decision_gate` with a `bool` question, then a `when` on `$.answers.<id>.value` == `true`, before the node that writes.

**Fanout gather + synthesize.** One fanout, then one agent that reads `$.results` and keeps successes, failures, and gaps. Read [dynamic-expansion.md](dynamic-expansion.md).

**Adaptive evidence rounds.** Prefer `bounded_feedback`. Explicit per-round fanout/evaluator pairs remain valid for a fixed number of rounds. Read [bounded-feedback.md](bounded-feedback.md).

### Evaluation architecture

Use bounded feedback as a typed judge only when another iteration has a specific decision to make.

- **State** — the evaluator reads validated evidence, failures, conflicts, and named gaps.
- **Transition** — continue only for one named material gap with distinct access, expected information, and narrower non-repeated work.
- **Progress** — the runtime rejects a repeated task collection, no new validated output, and a bound overrun.
- **Outcome** — synthesis declares succeeded, partial, or failed from retained evidence and gaps.

```jsonc
"work": {
  "itemSchema": { "type": "object", "required": ["source", "question"], "properties": { "source": { "type": "string" }, "question": { "type": "string" } } },
  "prompt": "Gather one atomic gap-closing fact: ${item}"
},
"evaluator": {
  "type": "agent",
  "prompt": "State/transition judge. ${feedback} Continue only for one named material gap with distinct access and expected new information; otherwise sufficient with named gaps.",
  "input": { "goal": { "path": "$.goal" } }
}
```

The injected decision links each `gapId` to a work item that satisfies `itemSchema`. Decision shape, bounds, and termination: [bounded-feedback.md](bounded-feedback.md).

### When not to add a judge

- One pass answers the request → use an ordinary fanout.
- A deterministic check decides → use a schema, a gate, or a condition.
- No typed evidence state exists → collect it first.
- No downstream decision or repair uses the verdict → evaluate offline.

## Before you run

- Every taken branch reads a schema'd enum.
- Every cycle is bounded: `loop` sits on the back edge into the judge.
- Side effects sit behind approval or a passing `validation.gate`.
- Outcome comes from a node that runs on every path that needs a verdict.
- Outputs read validated structured fields, not prose.
- Field names are spelled exactly.
- Every selector is permitted by the caller's mode.
- Model and thinking stay on the agent frontmatter.
- `resources` and graph-level `outputSchema` are omitted.
- A side-effect node is idempotent. A crash may run a dispatched node again.

## Debugging and refinement

The validator reports every error at once, with dotted paths (`nodes.review.prompt`, `edges[2].to`). A valid graph starts immediately; there is no dry run. Supervise a live run in `/agents → Graph runs` or `/agent-monitor`. Checkpoint, lease, and restore internals: [bounded-feedback spec](../../../../../docs/specs/agent-graph-bounded-feedback.md).

### Trace-driven refinement

1. Capture the graph, inputs, structured outputs, activated branches, failures, retries, bounds, cost, and latency. The run result carries outputs and, for bounded feedback, `feedback` (iterations, `reason`, `exhaustedBounds`). Every run writes `<runId>.trace.jsonl` (header, input, per-node status/attempt/output/error, end) to the session task artifact area `<tmpdir>/pi-subagents-<uid>/<encoded cwd>/<sessionId>/tasks/`, kept after the run settles and capped at 8 MiB. Session `graph-history.json` keeps per-node status, attempts, timing, and tokens without outputs. `.pi/graph-runs/` checkpoints are deleted when a run settles.
2. Name one transition failure. Have an agent other than the judged nodes propose one graph change. Keep authority, schemas, and hard bounds immutable.
3. Run the baseline and the candidate against the same replayable cases. Grade states (per-node output), edges (branches fired, loop iterations, retries, evaluator `continue` rate, rounds without new validated output), outcome, cost, and latency. For a cheap first check, a human can run `/agent-graph-replay <runId> <candidate>` in the same session: it folds the recorded outputs through the candidate's planner without model calls and diffs statuses, edges, loop counts, and outputs, listing nodes that need a live run (changed `outputSchema` or no recorded output). `fanout`, `bounded_feedback`, `expand`, and `graph` nodes replay atomically from their recorded output, and a ready wave settles in wave order, so a replay never replaces a live run.
4. Promote the candidate only after held-out improvement and human review. Retain the prior graph for rollback.

## Reference implementations

- [context-gather.graph.json](../../../../../agent-graphs/context-gather.graph.json) — evidence gathering with `semanticPolicy: "context-gather-v1"`.
- [deep-research.graph.json](../../../../../agent-graphs/deep-research.graph.json) — read-only cited research.
- Contracts: [agent-graphs/AGENTS.md](../../../../../agent-graphs/AGENTS.md).

Promote a proven inline graph to a saved root: `<cwd>/.pi/agent-graphs`, `<cwd>/agent-graphs`, `<cwd>/.agents/agent-graphs`, or `~/.pi/agent/agent-graphs`. Save it as `<name>.graph.json`; `.graph.yaml` is the fallback format. A `/` in the name is a subdirectory. Keep one format per name in a root.
