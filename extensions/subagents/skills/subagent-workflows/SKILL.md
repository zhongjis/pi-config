---
name: subagent-workflows
description: Author, modify, debug, or replay SubagentWorkflow JavaScript scripts. Covers orchestration, API, and replay safety; invoking this skill does not authorize execution.
---

You author bounded workflow scripts; the current Agent tool description owns agent types and their configuration.

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. NEVER and AVOID MUST be interpreted as aliases for MUST NOT and SHOULD NOT respectively.
</system-conventions>

<critical>
- You MUST obtain explicit workflow execution opt-in before invoking SubagentWorkflow.
- Reading/invoking this authoring skill NEVER grants execution permission.
- You MUST preserve delegation restrictions and per-action authorization.
- You NEVER weaken acceptance criteria to make results pass.
</critical>

## Authoring steps

1. Define acceptance criteria and authoritative evidence/tests before spawning. Mark required versus optional inputs; missing required evidence MUST block acceptance. Independent verification MUST inspect evidence, not merely count reviewer votes. Keep baseline changes outside the producing agent's authority.
2. Discover the work-list inline. Assign stable item/stage labels and disjoint write ownership; serialize overlapping writers. Separate proposals from actions requiring approval. Workflow opt-in does not authorize every action or shell command.
3. Choose the simplest sufficient structure. Use `pipeline` for independent item chains; use a `parallel` barrier only for true cross-item dependencies such as global deduplication or synthesis. Overlap can reduce idle time, not guarantee latency wins under caps/contention.
4. Define result schemas, failure handling, and stopping conditions. Retain item identity and test `value === null`, NEVER general truthiness: scalar fields/transformed results may be `false`, `0`, or `""`; text results may be empty strings. Schema results themselves are objects. Report attempted/successful/missing/rejected items and optional gaps rather than silently filtering them. Stop downstream acceptance when required results are missing or rejected.
5. Bound attempts/rounds and work-list size for the task. Log branch choices, retries, and omissions; return a meaningful stop reason (accepted, missing evidence, verification failed, or attempt limit). Runtime caps are backstops, not task budgets. Await every launch.
6. Write the script inline first. Include literal `meta`, explicit concurrent `opts.phase`, and relevant input/version identity in prompts/args. Before replay, assess changed upstream results, external inputs, and repeatable side effects.
7. You MUST review syntax, arguments, and null paths before launch. Runnable mock checks SHOULD cover nontrivial branching/repair logic: success, null/falsy data, failed verification, and bounded termination. AVOID new checker infrastructure for simple ephemeral scripts. Inspect actual evidence after authorized execution; NEVER equate a completed workflow with accepted work.

## Invocation and supervision

Explicit opt-in means the user asks in their own words to run a workflow/multi-agent orchestration, requests a specific saved workflow, or invokes a skill/command explicitly requesting execution. A task merely benefiting from orchestration does not count. Without opt-in, you MUST ask before execution; individual Agent calls remain subject to active delegation rules.

Pass `script` inline, not through a newly written file. Each invocation persists its script in the session task area and returns its path. For iteration, edit that file and call `{scriptPath: "<returned path>"}`. Repeated-use scripts MAY live in `.pi/workflows/<name>.js`, `.agents/workflows/`, or `<agent dir>/workflows/`; invoke with `{name: "<name>"}`. Source precedence: `scriptPath` → `script` → `name`. Pass `args` as actual JSON values, not JSON-encoded strings.

SubagentWorkflow returns immediately with a task ID and notifies on completion. You MUST NOT poll. Use `/agents → Workflows` for progress and pause/skip/retry/cancel supervision; pause prevents new starts, not already-running effects. Inspect completion and linked full-result artifacts. Scripts/journals are ephemeral session artifacts, independent of transcript settings.

## Runnable examples

Each fenced script is complete. Supply the stated JSON args; execution still requires opt-in.

You SHOULD select read-only types for evidence readers/verifiers. Both examples REQUIRE `readOnlyAgentType`: before invocation, choose it from the current Agent tool roster and check its configured tool/extension permissions permit only read-only work. No suitable type? You MUST stop before spawning; NEVER silently substitute general-purpose. The scripts reject absent/blank selectors; caller selection performs the permission check, not the script. Replace the sample placeholder with that live selector. “Change nothing” is prompt guidance, not configured permission enforcement or filesystem isolation. Gates require separate command authorization and are not restricted by the agent's tool permissions.

### 1. Read-only evidence pipeline with coverage

Args: `{ "readOnlyAgentType": "<live read-only selector>", "items": [{ "id": "readme", "path": "README.md", "required": true }] }`. Each item collects evidence then independently checks the claim against that source. `value` deliberately permits falsy values. Optional gaps remain visible.

```js
export const meta = {
  name: 'source-evidence', description: 'Collect and verify source evidence',
  phases: [{ title: 'Read' }, { title: 'Verify' }]
};
if (typeof args?.readOnlyAgentType !== 'string' || !args.readOnlyAgentType.trim()) {
  throw new Error('Provide a readOnlyAgentType checked against the current Agent roster permissions');
}
if (!Array.isArray(args?.items) || args.items.length === 0 || args.items.length > 20 ||
    args.items.some(item => !item || typeof item.id !== 'string' || !item.id ||
      typeof item.path !== 'string' || !item.path || typeof item.required !== 'boolean') ||
    new Set(args.items.map(item => item.id)).size !== args.items.length) {
  throw new Error('Provide 1..20 uniquely labelled source items with required flags');
}
const evidenceSchema = {
  type: 'object', properties: {
    value: { type: ['string', 'number', 'boolean'] }, evidence: { type: 'string', minLength: 1 }
  }, required: ['value', 'evidence'], additionalProperties: false
};
const verdictSchema = {
  type: 'object', properties: {
    supported: { type: 'boolean' }, evidence: { type: 'string', minLength: 1 }
  }, required: ['supported', 'evidence'], additionalProperties: false
};
const values = await pipeline(args.items,
  item => agent(`Read ${item.path}; change nothing. Report its purpose with a source location.`,
    { agentType: args.readOnlyAgentType, label: `read:${item.id}`, phase: 'Read', schema: evidenceSchema }),
  async (value, item) => {
    if (value === null) return null;
    const verdict = await agent(`Independently read ${item.path}; change nothing. Check this claim against the source, citing evidence: ${JSON.stringify(value)}`,
      { agentType: args.readOnlyAgentType, label: `verify:${item.id}`, phase: 'Verify', schema: verdictSchema });
    return verdict === null ? null : { ...value, verdict };
  }
);
const items = args.items.map((item, index) => ({ ...item, result: values[index] }));
const missing = items.filter(item => item.result === null);
const rejected = items.filter(item => item.result !== null && !item.result.verdict.supported);
const successful = items.length - missing.length - rejected.length;
log(`${successful}/${items.length} verified; missing: ${missing.map(item => item.id).join(', ')}; rejected: ${rejected.map(item => item.id).join(', ')}`);
return { accepted: ![...missing, ...rejected].some(item => item.required), attempted: items.length,
  successful, missing: missing.map(item => item.id), rejected: rejected.map(item => item.id), items };
```

### 2. Bounded repair with independent command verification

Args: `{ "readOnlyAgentType": "<live read-only selector>", "task": "Fix the failing parser test; edits only in src/parser.js", "check": "npm test" }`. Use only an already-authorized edit scope and check command. You MUST instruct the repair agent to preserve the acceptance command and checks; prompts alone do not protect tests or baselines. Verification runs even when repair text is empty; a missing repair or verifier result never passes. Each attempt starts fresh to support structured calls/gates; use child `resume` only with its restrictions below.

```js
export const meta = {
  name: 'bounded-repair', description: 'Repair within scope and verify at most twice',
  phases: [{ title: 'Repair' }, { title: 'Verify' }]
};
if (typeof args?.readOnlyAgentType !== 'string' || !args.readOnlyAgentType.trim()) {
  throw new Error('Provide a readOnlyAgentType checked against the current Agent roster permissions');
}
if (typeof args?.task !== 'string' || !args.task.trim() ||
    typeof args?.check !== 'string' || !args.check.trim()) {
  throw new Error('Provide an authorized task and acceptance command');
}
let reason = 'attempt limit';
const attempts = [];
for (let attempt = 1; attempt <= 2; attempt++) {
  const repaired = await agent(`${args.task}\nAttempt ${attempt}. Run the authorized acceptance command ${args.check} and inspect its failure evidence before repairing within the stated scope. Preserve the command and acceptance checks. Previous stop: ${reason}`,
    { label: `repair:${attempt}`, phase: 'Repair' });
  if (repaired === null) {
    attempts.push({ attempt, repaired, verified: null });
    return { accepted: false, reason: 'missing required repair result', attempts };
  }
  const verified = await agent(`Change nothing. Inspect the authorized acceptance command ${args.check} and report verification context.`,
    { agentType: args.readOnlyAgentType, label: `verify:${attempt}`, phase: 'Verify', gate: args.check });
  attempts.push({ attempt, repaired, verified });
  if (verified !== null) return { accepted: true, reason: 'acceptance command passed', attempts };
  reason = 'verification failed or missing';
  log(`Attempt ${attempt}: ${reason}`);
}
return { accepted: false, reason: `attempt limit: ${reason}`, attempts };
```

## API reference

Signatures below describe the API, not TypeScript to paste into scripts.

### Script grammar

Scripts MUST begin with `export const meta = {...}`. The object is a pure literal: no variables, calls, spreads, or template interpolation. Required nonempty strings: `name`, `description` (one-line card text). Optional `whenToUse` describes saved-workflow discovery; optional `phases` is an array of `{title, detail?, model?}`. Match `phase()` titles exactly; unmatched titles create their own groups. Phase `model` is display-only, not an override.

Scripts are plain JavaScript in an async context: top-level `await` and `return` work; TypeScript annotations/interfaces/generics do not. Standard built-ins such as JSON, Array, and Math are available. No filesystem or Node.js APIs. `eval`, `Function`, `Date.now()`, `Math.random()`, and argumentless `new Date()` throw. Pass timestamps/version identities through `args`; vary prompts/labels by index rather than random values. Explicit control flow does not make agent answers or concurrent completion order deterministic.

### `agent(prompt, opts?) → Promise<value | null>`

Without schema, returns final text, including valid empty strings. With `schema`, the child receives a `StructuredOutput` tool and returns a validated JSON object: no manual parsing. The schema root MUST explicitly declare `type: 'object'`; root scalar/array schemas or root `anyOf` without that type are unsupported. Wrap scalars/arrays in an object property, then unwrap only after checking the agent result for null. Example schema: `{type: 'object', properties: {value: {type: 'boolean'}}, required: ['value'], additionalProperties: false}`; after `result !== null`, `result.value` may validly be `false`. Invalid payloads are rejected for correction; missing structured output gets one additional prompt then fails. Skip, terminal API failure after retries, or failed gate returns `null`. You MUST handle null after every stage, including schema stages.

All accepted options:

| Option | Contract |
|---|---|
| `label: string` | Display identity; use stable item/stage labels. |
| `phase: string` | Explicit progress group; use inside concurrent stages to avoid global `phase()` races. |
| `schema: object` | JSON Schema with root `type: 'object'` for validated object output; composes with `agentType`. Use explicit required properties and evidence fields; wrap scalar/array values in properties. |
| `agentType: string` | Custom type from the current Agent tool registry; default general-purpose. |
| `model: string` | Select only when the definition has no model chain. Configured chains and `:fast` stay authoritative. Omit by default; absent configuration inherits the resolved session model. |
| `effort: string` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Authority: frontmatter → selected model-chain suffix → invocation effort → SDK selected-model default, NEVER parent thinking. Omit unless a justified override is needed. |
| `gate: string` | Shell command after successful agent completion, in effective child cwd. Nonzero exit fails the call; command output becomes its error. Prefer authoritative tests over model approval. |
| `resume: string` | Continue the child previously labelled with this value, retaining context/configuration. Cannot combine with `agentType`, `model`, `effort`, `gate`, or `schema`; `label` and `phase` remain usable. Re-verification needs a separate gated call. |

Unlisted options are rejected by name, including isolation options. A gate runs after work: it cannot undo effects or authorize the agent's actions or its own command. No filesystem isolation is provided.

### Orchestration and progress

| Hook | Contract |
|---|---|
| `pipeline(items, stage1, stage2, ...) → Promise<array>` | Each item traverses stages independently, without stage barriers. Every callback receives `(prevResult, originalItem, index)` (first result is the item). A thrown stage produces null at that item's position and skips remaining stages; an agent's returned null still needs an explicit guard in later stages. Retain original items/indexes for coverage. |
| `parallel(thunks) → Promise<array>` | Concurrent zero-argument async thunks; waits for all, preserving input positions. Ordinary thrown failures become null. Use the barrier for cross-item dependencies, not merely mapping/flattening. |
| `workflow(nameOrRef, args?) → Promise<value>` | Inline saved name or `{scriptPath: '...'}` composition; returns the child's return value. Child args become its `args`. Shares concurrency, agent counter, abort signal, and token accounting; appears in a nested progress group. Only one nesting level: a child's `workflow()` throws. Unknown names, unreadable paths, and syntax errors throw; catch only when an optional child failure is acceptable. |
| `phase(title) → void` | Sets the progress group for subsequent agent calls. |
| `log(message) → void` | User-visible narrator progress line. |
| `args` | Tool input verbatim; undefined when omitted. Arrays/objects MUST be actual JSON values. |
| `budget.total` | Always `null` here; there is no token-target directive. |
| `budget.spent() → number` | Output tokens spent by this run's agents, not total tokens or money. |
| `budget.remaining() → number` | `Infinity` without a target. NEVER treat budget as an enforced cost ceiling. |

Fatal cap breaches and nested-workflow load failures propagate through orchestration rather than becoming ordinary null results. Default concurrency is `max(1, min(16, available CPUs - 2))`; excess calls queue. Lifetime agent cap: 1000. Per `parallel`/`pipeline` item cap: 4096; overflow errors, not truncation. Choose smaller task-specific bounds and disclose any deferred coverage.

## Debugging and replay

1. Read `<run id>.workflow.jsonl` beside the persisted script for actual settled results before diagnosing unexpected/empty output; cached results are not necessarily nonempty. Use the inspector/progress and available child transcripts for labels, errors, and branch logs, not journal fields.
2. Fix syntax, options, missing required evidence, or prompts without relaxing acceptance. For changed upstream/external inputs, include their relevant identity in call inputs and revalidate mutable evidence live; matching prompts do not prove unchanged files.
3. Resume only a finished run in the same session with `{scriptPath, resumeFromRunId}`. Stop a running/paused run in `/agents → Workflows` first. Omitted source/args reuse recorded source (or its editable file) and original args.
4. Replay re-executes script control flow and caches only the longest successfully journaled unchanged positional prefix of `agent()` calls. First failed, changed, new, or missing entry ends reuse; that call and all later calls run live, even if later calls match. Missing journals mean no cached prefix. Runs containing child-session `resume` calls decline journal replay.
5. You MUST reassess side effects before retries/replay. This is neither cross-session recovery nor a transaction, rollback, or exactly-once guarantee. Cached calls do not rerun their gates; live calls can repeat external writes. Serialize or make authorized effects safely repeatable; otherwise stop for a decision.

<critical>
- You MUST separate authoring, execution opt-in, and action authorization.
- You MUST preserve failed-item identity and disclose partial coverage.
- You MUST bound loops and verify against unchanged acceptance evidence.
- You NEVER treat replay or gates as permission or rollback.
</critical>
