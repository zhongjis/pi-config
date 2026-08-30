# Cheap-First Subagent Task Delegation

Status: idea

## Question

How should Fu Xi and Kua Fu split software-engineering work so bounded tasks reach cheaper workers, while Juling remains an evidence-based exception for work requiring deeper reasoning?

## Short answer

Size work as the **coarsest cohesive packet that is decision-complete, independently verifiable, and fits one worker run**, not by arbitrary file counts or merely to create more agents. Split only at independent outcome, context, or verification boundaries, or worker-budget overflow; merge tiny tasks sharing writes or verification. A packet carries one objective, explicit inputs and scope, concrete artifacts, deterministic verification, dependencies, budget, and escalation conditions. Keep tightly coupled implementation and tests together.

Route **cheap-first only when the packet is clear, low-risk, locally scoped, and mechanically verifiable**. Jintong is the bounded non-UI default. Juling requires recorded architecture/data-ownership/trust-boundary reasoning, a security/concurrency/migration/performance invariant, ambiguous debugging after focused recon, cross-workstream integration, a diagnosed standard-worker reasoning failure, or increased risk. Size, file count, importance, and uncertain estimates alone are not triggers. Evaluate routing by cost per verified task, not token price or model reputation.

## What primary sources support

### Decomposition

Anthropic reports that effective delegated tasks need an objective, output format, tool/source guidance, and clear boundaries; vague delegation produced duplicate work, gaps, and misinterpretation.[1] Its coding-agent guidance also identifies automated tests as objective feedback, making verification a natural packet boundary.[2]

OpenAI warns against splitting into specialists too early: additional agents are justified when capability isolation, policy isolation, prompt clarity, or trace legibility materially improves the workflow.[3] Parallel delegation is safest for independent, read-heavy work; write-heavy tasks with shared state create coordination and conflict costs.[4] Anthropic similarly notes that coding work often has fewer independently parallel branches than research because edits share context and dependencies.[1]

Therefore:

- Split by independently testable behavior, context ownership, permission boundary, or safe parallelism.
- Do not split tightly coupled implementation and its test merely to reach a cheaper worker.
- Do not treat file count as complexity. One behavior may require several coupled files; one file may contain a difficult algorithm or security boundary.
- Delegate context-heavy search separately when its raw output would pollute the primary thread; both Anthropic and LangChain describe subagents as isolated contexts that return compact results.[5][6]

### Model routing

OpenAI's Codex guidance separates clear repeatable work, read-heavy scans, and ambiguous multi-step planning/validation into different model roles.[4] Exact model names are transient; durable distinction is task shape.

Published routing work supports empirical, role-specific selection:

- Microsoft Switchcraft chooses the lowest-cost model satisfying correctness constraints and reports that nominally cheaper models can cost more when they consume extra reasoning tokens or retries.[7]
- Microsoft AgentOpt evaluates model assignments per pipeline role under quality, cost, and latency constraints; reported best/worst combinations differed greatly at matched accuracy.[8]
- FrugalGPT demonstrates learned model cascades: attempt cheaper models first, escalate when needed.[9] This is not SWE-specific evidence, but it supports the cascade shape.

Correct metric is therefore:

```text
cost per verified task
  = initial run
  + retries
  + escalation
  + verification
  + integration/repair
```

Token price alone can choose the wrong worker.

### Failure and escalation

Microsoft Magentic-One uses durable task/progress ledgers, checks progress after assignments, and replans after sustained stalls.[10] Its concrete stall count is an implementation choice, not a universal threshold. SWE-agent shows that repository interface and tool design materially affect coding performance.[11] A worker failure can therefore mean missing context, weak tools, or bad packet design—not necessarily insufficient model intelligence.

Escalation should classify failure first:

1. **Missing input/context** → enrich packet; retry same tier.
2. **Tool/runtime failure** → repair environment; retry same tier.
3. **Unexpected coupling** → replan and merge.
4. **Reasoning-capability failure** despite complete context/tools → escalate model.
5. **Risk increased** → escalate or add stronger review/approval.

## Current harness diagnosis

### Fu Xi creates classifiable coarsest-cohesive packets

`modes/fuxi/skills/ulw-plan/references/full-workflow.md` sizes each todo as the coarsest cohesive decision-complete, independently verifiable packet fitting one worker run. It splits only at independent outcome/context/verification boundaries or worker-budget overflow, merges tiny tasks sharing writes/verification, keeps implementation plus tests together, and emits Objective, Artifacts, advisory Worker fit, Escalation triggers, and Recommended Max Turns.

This follows `docs/adr/0001-orchestration-sizing-follows-upstream-omo.md`: no brittle file-count guard; one logical plan item remains one resumable worker session.

### Hou Tu applies runtime routing to classifiable packets

Each plan todo maps 1:1 to a runtime task and worker session. Routing is explicit:

- Guangguang: mechanical, deterministic, low-risk, trivial single-file, no unresolved design
- Jintong: default bounded non-UI implementation, including cohesive multi-file changes
- Juling: exception requiring a recorded positive trigger
- Yunu: frontend owner

Fu Xi emits advisory evidence; Hou Tu retains runtime selection ownership.

### Guangguang has a narrow explicit territory

`agents/guangguang.md` remains limited to mechanical, deterministic, low-risk trivial single-file work with no unresolved design. Kua Fu self-executes only one obvious local action when cheaper than delegation; eligible small multi-turn packets route to Guangguang. Fu Xi never splits coupled implementation and tests merely to fit this tier.

```text
one obvious local action cheaper than delegation → Kua Fu self-executes
eligible mechanical small multi-turn packet         → Guangguang
bounded normal non-UI implementation                → Jintong
```

This preserves Guangguang's safety boundary while removing its former overlap with primary self-execution.

### Juling now has an evidence threshold

Active orchestrator and worker prompts require a recorded positive trigger and reject size, file count, importance, or uncertain estimate alone. Recovery classifies missing context and runtime failures as same-tier retries, unexpected coupling as replan/merge, and only diagnosed reasoning-capability failure or increased risk as escalation.

## Proposal ownership

### 1. Orchestrator agents and `ulw-plan` skill

#### Fu Xi / `ulw-plan`: construct classifiable task packets

Before delegation, every plan item should carry:

```yaml
objective: one externally observable outcome
artifacts: exact code/doc/result expected
worker_fit: Guangguang | Jintong | Juling | Yunu # advisory; runtime owns selection
escalation_triggers: positive Juling triggers or none
scope: owned files/symbols/domain; explicit exclusions
references: decisions and evidence worker must not rediscover
acceptance: command/assertion proving completion
qa: exact scenarios, invocations, and evidence paths
commit: allowed flag and message
recommended_max_turns: positive integer
```

A packet is cheap-worker eligible only when:

- its objective has one interpretation;
- required decisions are already made;
- context is local and compact;
- actions are reversible or low risk;
- verification is deterministic and focused;
- no architecture, security, migration, or public-contract judgment remains;
- expected work fits one bounded run without broad rediscovery.

Fu Xi should split plans in this order:

1. Write desired observable outcomes.
2. Attach one verification boundary to each outcome.
3. Merge outcomes whose writes or verification are tightly coupled.
4. Split outcomes with independent context, permissions, artifacts, or tests.
5. Order packets by data and decision dependencies.
6. Supply decisions and references so workers execute rather than rediscover.
7. Record advisory worker fit and explicit escalation triggers.
8. Avoid assigning an expensive worker merely from task size; runtime routing owns worker selection.

This preserves one logical plan item → one resumable worker session while producing decision-complete, classifiable packets. It also preserves ADR 0001: no fixed file-count rejection and no partial-slice lifecycle.

#### Kua Fu / Hou Tu: apply the runtime routing ladder

The orchestrator should classify a complete packet, then route:

```text
one obvious local action cheaper than delegation → primary self-execution
mechanical + deterministic + Guangguang contract → Guangguang
bounded normal non-UI implementation           → Jintong
positive complex/high-risk trigger              → Juling
```

Jintong should be the default implementation worker. Juling requires at least one recorded trigger:

- architecture/data-ownership/trust-boundary reasoning;
- security/concurrency/migration/performance invariant;
- ambiguous debugging after focused recon;
- cross-workstream integration;
- diagnosed standard-worker reasoning failure;
- increased risk.

Size, file count, importance, or uncertain estimate alone do not qualify.

Before escalation, classify the failure:

1. **Missing input/context** → enrich packet; retry same tier.
2. **Tool/runtime failure** → repair environment; retry same tier.
3. **Unexpected coupling** → replan and merge.
4. **Reasoning-capability failure** despite complete context/tools → escalate model.
5. **Risk increased** → escalate or add stronger review/approval.

Kua Fu should also distinguish one obvious local action from small work requiring several expensive primary-model turns. The first may be cheaper to execute directly; the second may be cheaper through Guangguang.

### 2. Subagent descriptions and contracts

#### Guangguang

Current contract permits trivial single-file work only. Two coherent options exist:

1. Keep that boundary and accept low utilization.
2. Widen it to “one local, mechanically verifiable outcome” only after routing evals show acceptable quality and total cost.

Under either option, its description should emphasize mechanical execution, deterministic verification, low risk, and no unresolved design decisions. Do not manufacture Guangguang work by separating a behavior from its required test or splitting coupled writes.

#### Jintong

Its description should establish Jintong as the default bounded non-UI implementation worker. It should explicitly accept normal tightly coupled multi-file behavior changes when decisions are complete and focused verification exists. “Not trivial” should map to Jintong, not automatically to Juling.

#### Juling

Its description should define complex/higher-risk through observable intake triggers matching the runtime list above. It should state that task size or file count does not independently justify the expensive tier. Prefer Juling after positive risk evidence or a diagnosed lower-tier reasoning failure, not defensive uncertainty.

### 3. Other: evaluation, telemetry, and optional enforcement

#### Routing evaluation

Build a benchmark from recent real tasks:

- trivial single-file edits;
- standard bounded multi-file changes;
- ambiguous debugging;
- architecture/high-risk changes;
- tasks that previously overused Juling;
- tasks where Guangguang stopped or was bypassed.

Replay each class through Guangguang, Jintong, and Juling where policy permits. Record first-pass success, verified success, retries, escalations, tokens, latency, tool calls, scope violations, and total cost. Compare fixed Juling, fixed Jintong, and cheap-first cascade policies. Grade traces, not only final patches.[12]

Promote routing rules only when a cheaper tier preserves the required verified-success rate and lowers total cost per verified task. This matches Uber's benchmark/Pareto approach: benchmark real work, compare models in one harness, and select per-workload quality, reliability, and cost per completed task.[13]

#### Routing telemetry

Record:

- selected worker and routing reason;
- escalation reason and originating tier;
- Juling calls without an approved positive trigger;
- Guangguang-eligible tasks handled directly or routed upward;
- worker stops caused by packet scope, missing context, tools, or reasoning.

#### Optional runtime enforcement

After prompt-level policy proves useful, the runtime may validate packet fields, require machine-readable routing/escalation reasons, and enforce budgets or stop conditions outside prompt text. This is a later hardening step, not required for the initial prompt/skill change.

## Sources

[1] Anthropic, “How we built our multi-agent research system” (https://www.anthropic.com/engineering/multi-agent-research-system)

[2] Anthropic, “Building effective agents” (https://www.anthropic.com/engineering/building-effective-agents)

[3] OpenAI, “Orchestration and handoffs” (https://developers.openai.com/api/docs/guides/agents/orchestration)

[4] OpenAI, “Subagents – Codex” (https://developers.openai.com/codex/subagents)

[5] Anthropic, “Create custom subagents” (https://docs.anthropic.com/en/docs/claude-code/sub-agents)

[6] LangChain, “Subagents” (https://docs.langchain.com/oss/python/langchain/multi-agent/subagents)

[7] Microsoft Research, “Switchcraft: AI Model Router for Agentic Tool Calling” (https://www.microsoft.com/en-us/research/publication/switchcraft-ai-model-router-for-agentic-tool-calling/)

[8] Microsoft Research, “AgentOpt v0.1 Technical Report” (https://www.microsoft.com/en-us/research/publication/agentopt-v0-1-technical-report-client-side-optimization-for-llm-based-agent/)

[9] Stanford researchers, “FrugalGPT” (https://arxiv.org/abs/2305.05176)

[10] Microsoft Research, “Magentic-One” (https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)

[11] Princeton/Stanford, “SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering” (https://arxiv.org/abs/2405.15793)

[12] Panda Harness, “Agent Harness Evals” (`.pi/skills/agents-best-practices/references/evals.md`)

[13] Uber Engineering, “Building an Efficient Software Factory” (https://www.uber.com/us/en/blog/efficient-software-factory/)
