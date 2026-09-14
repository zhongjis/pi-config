# Graph engineering and SubagentWorkflow

Status: idea

Research and recommendations, not an implementation plan or execution policy.

## Conclusion

Keep our imperative workflow runtime. Apply graph engineering to how we define success, connect verification to execution, record dependencies, and govern changes. A new graph DSL is not the prerequisite.

Eigent uses **graph engineering** to mean a network of feedback loops: which loops measure, which set targets, which can veto changes, and which evidence stays outside the optimizer's control. It is broader than an execution graph of agent calls.[1] Our `SubagentWorkflow` is an execution mechanism on which some of those practices can be built.

## The distinction

```text
Execution structure — what runs next

research sources ──┐
inspect code ──────┼─> compare findings ─> report
check alternatives┘

Feedback and authority structure — what makes the result acceptable

user acceptance criteria ──────────────────────┐
independent evidence ─> verification ─> accept / revise / stop
                                 ^             │
                                 └─────────────┘

The working agent cannot silently weaken the acceptance criteria.
```

Eigent explicitly asks who owns targets, who can veto or roll back changes, and which measurements must remain frozen. Its proposed operational, quality, governance, and audit loops operate at different cadences. Its own conclusion describes the product as a canvas, not proof that the governance discipline comes built in.[1]

Three categories should remain separate:

| Category | Question | Our position |
|---|---|---|
| Design discipline | How do work, verification, authority, and feedback relate? | Applicable now in workflow authoring and human review. |
| Representation | Are dependencies explicit nodes/edges or expressed through code? | JavaScript functions, promises, conditions, and loops. |
| Runtime guarantees | What is scheduled, validated, recorded, replayed, or paused? | Substantial execution support; limited replay rather than durable transactional recovery. |

A graph can contain cycles; it need not be a DAG. Conversely, ordinary code can express graph-shaped execution. LangGraph's Functional API and Graph API share a runtime: imperative authoring can coexist with checkpointing and interrupts. The Graph API offers explicit graph visualization, while the Functional API avoids requiring explicit graph construction.[3] Therefore, adopting a graph representation and adopting durable execution are separate decisions.

## What our tool already provides

Local source findings:

- **Dynamic work and composition:** `extensions/subagents/src/workflow/worker-source.ts:545–669` implements `parallel`, per-item `pipeline`, and nested workflows. Calls can be determined from earlier results rather than fixed before execution.
- **Validated boundaries:** `extensions/subagents/src/workflow/runtime.ts:303–359,463–499` validates JSON-compatible values and structured results and runs post-agent command gates.
- **Execution visibility:** `extensions/subagents/src/workflow/progress.ts:52–114` records agent identities, phases, errors, timing, usage, and previews. Grouping agents by phase is not a complete data-dependency graph.
- **Replay:** `extensions/subagents/src/workflow/journal.ts:11–44,79–151` records settled calls and matches a successful positional prefix using call hashes. It does not snapshot arbitrary JavaScript state or prove that external files remain unchanged. Runs containing child-session resume calls decline journal replay. Missing journals provide no cached entries; malformed individual lines are skipped rather than necessarily discarding all valid records. Journal writes are best-effort.
- **Same-session resume:** `extensions/subagents/src/workflow/task.ts:241–279` requires the prior run to remain known in the current session and not be running or paused.
- **Controls and limits:** `extensions/subagents/src/workflow/runtime.ts:27–49,212–240` provides concurrency/count limits and pause, skip, retry, and resume controls. Pause stops new starts; it does not revoke effects already underway or serve as a durable human approval request.

The workflow authoring skill also documents schemas, test gates, independent reviewers, saved scripts, and bounded runtime fan-out. These are existing capabilities to reuse, not new graph-engineering features to rebuild.

The control rules are executable and explicit, but agent answers and concurrent completion order remain variable. “Deterministic workflow” does not mean identical LLM outputs or identical external effects across runs.

## What the primary sources contribute

### Eigent: govern the feedback, not just the task sequence

Its strongest contribution is **anchors**: external references that the optimizing loop cannot rewrite, paired with counter-metrics and independent audits. This guards against a system whose internal reports agree while its real outcomes worsen.[1]

For us, that suggests user-approved acceptance criteria, protected baseline checks, direct source evidence, and real-environment verification. This is an application of the article, not a claim that any test or human judgment is infallible. Evidence can become stale; changes to the acceptance baseline need separate review.

The article is a vendor-authored conceptual argument. Its claims that graph engineering is the next stage of the industry are not comparative benchmark evidence. Do not infer that buying or adopting a graph runtime automatically supplies sound governance.[1]

### Anthropic: use complexity only when it earns its cost

Anthropic recommends the simplest sufficient design and distinguishes predefined workflow paths from model-directed agents. Its evaluator–optimizer pattern is appropriate when evaluation criteria are clear and repeated refinement offers measurable value.[2]

For us: independent reviewers can help, but adding reviewers is not itself evidence of better results. Use tests or direct evidence where available; measure whether review improves the final artifact enough to justify latency, tokens, and human checking.

### LangGraph: explicit recovery boundaries matter more than syntax

The Functional API can replay from an entrypoint while restoring completed task results. Its documentation requires nondeterminism and side effects to be contained within checkpointed task boundaries; incomplete tasks can execute again, so external writes still need idempotency.[3]

Interrupts persist state and wait for external input. Resuming can restart the containing node, including code before the interrupt, so placement and idempotency matter.[4]

For us: our same-session prefix cache is useful, but should not be described as cross-session crash recovery, exactly-once execution, or rollback. A post-agent `gate` checks after work; it is not permission to perform that work.

### OpenAI: evaluate the executed trace, not only the final answer

OpenAI's agent-evaluation guidance scores end-to-end traces, including tool selection, handoffs, policy violations, and routing changes.[5]

For us: check whether a research workflow opened its cited sources, preserved failed branches, used independent verification, and obtained any required approval—not just whether its report looks convincing. This does not require adopting OpenAI's evaluation platform.

## Recommended application, in order

These are proposals, not shipped contracts.

| Priority | Change | Smallest useful version | Evidence of benefit |
|---|---|---|---|
| 1 | Define success and independent checks before spawning | Add authoring guidance for acceptance criteria, evidence requirements, a bounded revise/verify loop, and an explicit stopping reason. Keep baseline approval outside the producing agent. | A plausible but unsupported result is rejected; the agent cannot pass by relaxing its own criteria. |
| 2 | Preserve partial failure and coverage | Retain item identity; check `value !== null`; report attempted, successful, and missing items. Stop when a required input is missing. | One failed source produces a disclosed gap, not a falsely complete report. Valid `false`, `0`, and empty strings survive. |
| 3 | Make ownership and replay safety explicit | Assign disjoint write targets or serialize overlapping writers. Include relevant input/version identity in call inputs, and revalidate mutable evidence after replay. Separate proposal from authorized action. | Cached results are not mistaken for fresh verification; retries do not duplicate consequential effects. |
| 4 | Evaluate a small set of real personal tasks | Compare one-agent and workflow runs on a handful of research, review, and migration cases. Record correctness, omissions, review effort, latency, usage, and trace-level rule violations. | A change improves actual outcomes rather than merely increasing agent count or pass rate. |
| 5 | Add more lineage only if debugging requires it | Start with stable item/stage labels and logs for branch choices, retries, and omissions. Later consider explicit input/result references as observational metadata. | We can explain which evidence led to a decision without reconstructing every transcript. |

The first changes belong mainly in the on-demand authoring skill and small runnable checks. They do not require changing scheduling or the tool schema.

Specific current authoring weaknesses, visible in `extensions/subagents/skills/subagent-workflows/SKILL.md`:

- `.filter(Boolean)` removes valid falsy results as well as `null`; it is inappropriate as a general success test.
- The count-based discovery example dereferences a potentially null result and lacks a task-level round ceiling.
- Pipeline overlap can reduce idle time, but the claim that wall-clock time equals the slowest item chain is not a general guarantee under concurrency limits and resource contention.
- The script's `budget.total` is documented as `null`, and `budget.spent()` counts output tokens. These are not an enforced total-cost budget. The large runtime agent cap is a runaway backstop, not a sensible task budget.

These findings justify a focused authoring-skill revision, but no such revision was made for this research task.

## What to defer

- A graph DSL, mandatory graph specification, or visual graph editor.
- Static graph inference from arbitrary JavaScript; runtime-dependent calls make completeness difficult.
- Automatic objective changes or self-modifying evaluators.
- Cross-session durable checkpoints until lost or long-lived runs justify the design cost.
- Runtime approval interrupts until multi-phase external writes make separate proposal/approval/execution turns inadequate.

Durability and approval are useful capabilities, not cosmetic graph features. If added, they need explicit state ownership, permission binding, cancellation behavior, replay rules, and idempotency tests.[3][4]

## Research method and limitations

Used `SubagentWorkflow` run `wf_5ccf65c9439b`: Eigent/CAMEL research, independent primary-source research, local implementation analysis, then an architecture reviewer. All four workers completed. The parent then opened the five sources below and inspected the central replay implementation before synthesizing this note.

One research packet supplied an inconsistent access date. That date was discarded; the primary pages were reopened rather than treating the packet's metadata as evidence. Eigent's displayed publication date is July 21, 2026.[1]

The CAMEL/Eigent implementation packet was useful context but is not used here to assert feature parity or benchmark performance. No complete third-party implementation audit or comparative performance experiment was conducted. This note recommends measurements; it does not claim measured quality gains.

No production code, tool contract, or authoring skill was changed. The existing DOX ownership and documentation-bucket rules remain applicable without amendment.

## Sources:

[1] Eigent, Graph Engineering for AI Agents: Beyond Single Feedback Loops (https://www.eigent.ai/blog/graph-engineering-ai-agents)

[2] Anthropic, Building Effective AI Agents (https://www.anthropic.com/engineering/building-effective-agents)

[3] LangChain, Functional API overview (https://docs.langchain.com/oss/python/langgraph/functional-api)

[4] LangChain, Interrupts (https://docs.langchain.com/oss/python/langgraph/interrupts)

[5] OpenAI, Evaluate agent workflows (https://platform.openai.com/docs/guides/agent-evals)
