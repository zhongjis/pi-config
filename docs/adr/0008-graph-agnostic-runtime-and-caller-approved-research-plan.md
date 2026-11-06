# 8. The agent graph runtime is graph-agnostic, and the Caller approves the deep-research plan

Status: shipped
Date: 2026-11-06
Related: [../../extensions/subagents/GLOSSARY.md](../../extensions/subagents/GLOSSARY.md) · [../../agent-graphs/deep-research.graph.json](../../agent-graphs/deep-research.graph.json)
Supersedes: [ADR 0005](0005-decision-gate-classifier-first-with-orchestrator-escalation.md) item 4 only (deep-research plan gate and deterministic pre-check)

## Context

An audit of one deep-research run found that no stakeholder owned scope, sufficiency, or a readable result:

- The planner invented scope. A classifier scope gate second-guessed it and escalated.
- The judge required a primary source and no open gap for every part. Parts about performance evidence and use-case fit could never meet that rule, so research always ran until a bound stopped it.
- The evaluator carried every worker gap forward. A history query that the seed prompt invented became tasks filed under valid parts.
- The Caller received the report only as an escaped JSON string.

The runtime also held graph-specific code. The `semanticPolicy` values `deep-research-v1` and `context-gather-v1` rewrote node inputs and validated outputs by graph name. A reader of a definition could not tell what its nodes received.

## Decision

1. **Three stakeholders.** The agent graph runtime executes every run the same way. The agent graph definition owns its nodes, node agents, prompts, and outputs. The Caller supplies input, resolves escalations, and presents the result; the human reaches a run only through the Caller.
2. **No graph-specific runtime code.** Both semantic policies are removed, with `skipsJudge`, the gap-attempt limit, the opened-URL prompt list, and ledger deduplication. Bounded feedback hands the judge, evaluator, and writer one flat item list with positional IDs.
3. **Generic runtime additions.** A decision gate may declare `escalate: "always"`. A gate resolution may carry a free-text `note`, passed to the loop-back node. A `$report` output is saved as a Markdown file and returned as plain text with its path. A round that asks for more items than remain runs the first ones that fit, in evaluator order.
4. **The Caller approves the deep-research plan.** After seed searches, the planner writes parts, a `doneWhen` bar per part, and tasks. An always-escalating gate sends the plan to the Caller, who approves it or rejects it with a note. The approved plan is the contract for the rest of the run.
5. **Sufficiency follows the approved bars.** The judge asks one question, whether every approved part meets its `doneWhen`, with `minConfidence: 0`. The evaluator writes tasks only toward an approved bar, most important first. A new topic becomes an outside-plan gap in the report, not a mid-run plan change.
6. **Cangjie writes the report** as Markdown, from supplied evidence only, under a contract in its node prompt.

## Consequences

- deep-research pauses once per run for the Caller; the rest of the run stays autonomous.
- Nothing checks that report citations exist in the evidence. A fabricated URL or ID reaches the report unnoticed; the upgrade path is a generic output check that references must exist in the input.
- context-gather loses its coverage-ID checks.
- The `deep-research-v1` plan gate and deterministic pre-check from ADR 0005 item 4 no longer apply. Its classifier-first rule still governs every gate that does not declare `escalate: "always"`.
- Simaqian has no remaining agent graph user.

Rejected alternatives:

- **Caller supplies the parts up front.** A deep-research Caller usually cannot know them before seed evidence exists.
- **A structured brief input field.** Plan approval applies the Caller's knowledge at the point it matters.
- **Mid-run plan changes through a between-round gate.** Needs new bounded-feedback structure; outside-plan gaps let the Caller start a follow-up run.
- **A code check that task part IDs are approved.** The off-topic task in the audited run used valid part IDs; the cause was two prompts.
- **Per-part judge questions.** Gate questions are static in the definition; the evaluator already targets parts by gap ID.
- **`minConfidence: 1` to force escalation.** A classifier answer of exactly 1.0 still passes.
- **The Caller or a runtime template writes the report.** The first pulls the evidence into the Caller's context and couples it to graph internals; the second reads like a form.
- **Keep the gap-attempt limit.** At three iterations it equals the iteration bound.
- **Keep the opened-URL prompt list or move it to a shared file.** Round 2 reopened 8 of its 49 references despite the list; a shared file adds concurrent writers.
