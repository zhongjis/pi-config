# 5. Decision gates are classifier-first with orchestrator escalation

Status: shipped
Date: 2026-10-08
Related: [../../extensions/subagents/AGENTS.md](../../extensions/subagents/AGENTS.md) · [../../agent-graphs/deep-research.graph.json](../../agent-graphs/deep-research.graph.json) · [0004-graph-actor-context-is-an-owned-mutable-aggregate.md](0004-graph-actor-context-is-an-owned-mutable-aggregate.md)

## Context

Agent graphs have three gate node types — `human_gate`, `agent_gate`, and `hybrid_gate` — that expose only `{approved: boolean}`. A configured Subagent (often Panguan) or a human decides them.

Pi 1.1.0 offers classifier models: non-chat models that return typed bool, choice, or score answers with probabilities, through `ctx.modelRegistry.findOfType`, `getAvailableOfType`, and `classify`.

deep-research uses Panguan twice: as an `agent_gate` scope judge, and as the bounded-feedback evaluator that both judges coverage and writes gap tasks.

## Decision

1. **One gate type.** `decision_gate` replaces all three gate types. It wraps one classifier call: `state` (ValueRefs), `questions` (Pi's `ClassifierQuestion` shape), and optional `minConfidence` (default 0.8, from subagents settings). Its output is `{answers: {id: {value, confidence}}, decidedBy}`.
2. **One mixed model chain.** The `tool_models.json` key `subagents.decision_gate` holds a chain walked in written order. Entries that resolve as classifier models classify. Other entries run a built-in, unregistered, tool-free agent fallback ([graph-classifier-agent.md](../../extensions/subagents/builtin-agents/graph-classifier-agent.md)) that emulates a classifier. Unavailable or failed entries advance; a valid answer is final.
3. **Orchestrator escalation.** Any answer below `minConfidence`, or an exhausted chain, escalates to the orchestrator that invoked the graph through the durable gate pause: `get_agent_result`, then `resolve_agent_graph_gate` with `{answers, decidedBy: "orchestrator" | "human"}`. The orchestrator decides or asks the human. No human-only gate remains.
4. **Judged bounded feedback.** `bounded_feedback` gains an optional `judge`: a `decision_gate` with one bool question. With a judge, the evaluator only writes `{gaps, tasks}`, and `tasks: []` stops with "no accessible route". deep-research uses a plan gate and a coverage judge with a deterministic pre-check; Wenchang writes gap tasks. Panguan is retired; its rules seed the agent fallback.
5. **Hard break.** The old gate types are removed with no aliases. Persisted runs that contain them fail on resume with a specific error.

## Consequences

- Classifier calls are cheaper and calibrated, but a classifier may not be configured. The agent fallback, whose confidence is self-reported and uncalibrated, will often decide.
- Autonomous graphs can pause for the orchestrator. Escalation wait counts against bounded-feedback deadlines.
- `decidedBy: "human"` is self-declared by the orchestrator.
- llama.cpp chain entries always run as classifiers. Upgrade path: a `classifier:` chain marker.
- Bounded feedback has two stop modes until context-gather adopts a judge.
- Old persisted runs cannot resume.

Rejected alternatives:

- **Keep three types and make agent gates classifier-first.** Preserves the split this decision removes.
- **Add a fourth `classifier_gate` type.** Adds a type instead of unifying.
- **Human as the default final fallback.** The invoking orchestrator decides or asks the human instead.
- **First available classifier instead of an explicit chain.** llama.cpp lists every chat model as a classifier.
- **Per-node chain override.** Not adopted; one chain serves all gates.
- **Ask the agent for a second opinion after a low-confidence classifier answer.** Low confidence escalates to the orchestrator instead.
- **One ledger execution per chain entry.** Execution budgets must be static for restore.
- **Register the agent fallback as a built-in roster agent.** The registry feeds roster, delegation, and RPC, and a same-name user agent could replace it.
- **Eager guarded evaluator materialization in bounded feedback.** Deadlocks: the scheduler skips unreachable nodes only when nothing is owned.
- **Per-part dynamic coverage questions.** Deferred for simplicity.
- **Require a judge on every `bounded_feedback`.** context-gather stays unchanged.
