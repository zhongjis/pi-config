# Manifesto

Panda Harness is one user's [Pi](https://github.com/mariozechner/pi-coding-agent) coding-agent harness: Mode Agents, Subagents, Extensions, and typed agent graphs. This page states the principles behind it, in the shape of [oh-my-openagent's manifesto](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/manifesto.md), which inspired it. It explains why, not what: code, `rules/`, ADRs, and specs own behavior and win on any conflict ([authority order](README.md#authority-order)).

---

## Intervention Means Failure

**A human stepping in mid-task is a defect in the harness.**

The human has two jobs: state the intent and approve the plan. After that, the harness should finish the work.

Intervention during the work counts as failure:

- finishing the agent's half-done code
- guiding it step by step
- clarifying the same requirement twice

Each needed intervention points to a defect to fix in a prompt, a contract, or the runtime. The harness is built to need fewer of them:

- The [Kua Fu intent gate](../modes/kuafu/mode.md) exhausts repo context before it asks one precise question.
- Workers stop only when the task is genuinely ambiguous ([ADR 0001](adr/0001-orchestration-sizing-follows-upstream-omo.md), [Jintong](../agents/jintong.md)).
- On failure, the [recovery policy](../modes/kuafu/mode.md) tries a materially different hypothesis and consults Taishang before a third attempt.
- Decision gates ask a classifier first and escalate to the orchestrator only below the confidence bar ([ADR 0005](adr/0005-decision-gate-classifier-first-with-orchestrator-escalation.md)).
- Fu Xi turns intent into an approved plan; Hou Tu runs that plan ([orchestration guide](guides/orchistration.md)).

Approving a plan is stating intent. It is the human's half of the work, not an interruption of the agent's half.

---

## Personal by Design

**One user, one harness.**

Panda Harness fits one person's work. It is not a shared framework, a template, or a CI-heavy setup ([README](../README.md), [root AGENTS.md](../AGENTS.md)). Choices that suit this user need no justification for anyone else.

---

## No Evidence, No Done

**Delegation does not replace verification.**

A worker's report is a claim. The orchestrator reads the changed files, reviews the diff against the request, and runs the integration checks and QA itself before it calls work complete ([Kua Fu verification](../modes/kuafu/mode.md); Hou Tu's checks in the [orchestration guide](guides/orchistration.md)).

---

## Specialists, One Owner

**Many hands, one accountable orchestrator.**

- Mode Agents route work to leaf Subagents; no Subagent delegates further ([agent orchestration](guides/agent-orchestration.md), [mode-scoped delegation](specs/mode-scoped-subagent-delegation.md)).
- One cohesive packet goes to each worker; implementation and its tests stay together.
- Independent chunks run in parallel.
- The orchestrator keeps the outcome: routing, review, and final acceptance stay with it.

---

## Smallest Correct Change

**Agent code should read as if the codebase wrote it.**

- Follow existing patterns.
- No scope creep and no speculative abstraction.
- Prefer behavior-preserving changes and small, localized refactors ([README boundaries](../README.md), [extensions contract](../extensions/AGENTS.md)).

---

## Rules Live in Code

**Prompts persuade; code enforces.**

A rule that matters belongs where the runtime can check it. `agent_graph` is the single execution tool, built on typed graphs ([ADR 0002](adr/0002-remove-subagentworkflow-script-runtime.md)). The runtime, not the model, validates decisions, enforces topology and budgets, bounds feedback loops, and persists each transition ([bounded feedback](specs/agent-graph-bounded-feedback.md)). Durable checkpoints are the source of truth ([ADR 0004](adr/0004-graph-actor-context-is-an-owned-mutable-aggregate.md)). Work that runs long resumes in place from its last green state ([ADR 0001](adr/0001-orchestration-sizing-follows-upstream-omo.md)).

Background reading: [Goodbye slop, welcome determinism](ideas/goodbye-slop-welcome-determinism.md) (an idea, not shipped behavior).

---

## Tokens Buy Evidence

**Spend where it buys evidence or time.**

- Do trivial local work directly when that is cheaper than delegating.
- Launch independent work together instead of one after another.
- Add an agent only when it cuts elapsed time or adds distinct coverage.
- Send quick, mechanical work to a fast worker.
- Match prompts to the model family ([model families](../modes/MODEL-FAMILIES.md)).
- Stop research once the evidence is enough to decide ([Kua Fu](../modes/kuafu/mode.md)).

---

## Code Is Truth

**Docs describe the present and link to the code.**

- Docs state current behavior and link to owning code instead of copying it ([documentation rules](../AGENTS.md#documentation-rules)).
- A hierarchy of DOX `AGENTS.md` files binds each subtree.
- One vocabulary: [GLOSSARY.md](../GLOSSARY.md); retired terms go away ([ADR 0003](adr/0003-retire-workflow-terminology.md)).
- Borrow from upstream openly. The [prompt parity spec](specs/mode-prompt-parity.md) maps upstream to local, and decisions to diverge or follow are recorded as ADRs ([ADR 0001](adr/0001-orchestration-sizing-follows-upstream-omo.md)).

---

## The Core Loop

```
  human: state intent, approve plan
              |
              v
  +-----------------------------+
  | orchestrator routes work    |
  |   -> specialists (parallel) |<--+
  |   -> runtime checks rules   |   | recover: new hypothesis,
  |   -> orchestrator verifies  |---+ consult, retry
  +-----------------------------+
              |
              v
     verified evidence -> done

  human re-enters only on true failure,
  and that failure becomes a harness fix
```

| Principle | Where it lives |
|-----------|----------------|
| Intervention means failure | [Kua Fu](../modes/kuafu/mode.md), [ADR 0005](adr/0005-decision-gate-classifier-first-with-orchestrator-escalation.md), [orchestration guide](guides/orchistration.md) |
| Personal by design | [README](../README.md), [root AGENTS.md](../AGENTS.md) |
| No evidence, no done | [Kua Fu](../modes/kuafu/mode.md), [orchestration guide](guides/orchistration.md) |
| Specialists, one owner | [agent orchestration](guides/agent-orchestration.md), [mode-scoped delegation](specs/mode-scoped-subagent-delegation.md) |
| Smallest correct change | [README](../README.md), [extensions contract](../extensions/AGENTS.md) |
| Rules live in code | [bounded feedback](specs/agent-graph-bounded-feedback.md), [ADR 0002](adr/0002-remove-subagentworkflow-script-runtime.md), [ADR 0004](adr/0004-graph-actor-context-is-an-owned-mutable-aggregate.md) |
| Tokens buy evidence | [model families](../modes/MODEL-FAMILIES.md), [Kua Fu](../modes/kuafu/mode.md) |
| Code is truth | [GLOSSARY.md](../GLOSSARY.md), [ADR 0003](adr/0003-retire-workflow-terminology.md), [prompt parity](specs/mode-prompt-parity.md) |

---

## What This Is Not

- Not a shared framework or template.
- Not a set of rules that live only in prompts.
- Not a roadmap; it describes the harness as it is.

---

## Further Reading

- [Documentation index](README.md)
- [Orchestration guide](guides/orchistration.md)
- [Agent orchestration across modes](guides/agent-orchestration.md)
- [Modes](../modes/README.md)
- [Glossary](../GLOSSARY.md)
