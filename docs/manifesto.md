# Manifesto

Panda Harness is one user's [Pi](https://github.com/mariozechner/pi-coding-agent) coding-agent harness: Mode Agents, Subagents, Extensions, and typed agent graphs. This page holds the core principles for developing it. Code is anything that takes effect when the harness runs: prompts, extension source, agent graphs, and runtime config. Code wins any conflict with this page about what the harness does; when you change the harness, move it toward this page. This page outranks the other docs (`rules/`, ADRs, specs, guides, ideas): a doc that conflicts with it gets revised, and an ADR through a new ADR ([authority order](README.md#authority-order)).

---

## Human Intervention Is a Failure Signal

**The human states intent; the harness does the work.**

Intent is not intervention. These are intent:

- stating what to build
- changing your mind mid-task, which is new intent
- answering an interview or grilling the human asked for
- approving a plan

Intervention during the work is a failure signal: finishing half-done work, guiding step by step, or re-clarifying the same requirement. Investigate it and fix the prompt, contract, or runtime that caused it. This is a mindset; nothing tracks interventions.

Involve the human for exactly two reasons:

1. Authorization or scope only the human can grant.
2. Missing access, credentials, or external state.

Everything else is a harness defect, with its fix:

- A missing preference gets recorded in an `AGENTS.md` or a skill.
- A destructive or irreversible action is avoided unless an approved requirement already covers it.
- Exhausted recovery stops at the last green state and reports. That stop is a harness defect, not a valid escalation.

Existing mechanisms:

- The [Kua Fu intent gate](../modes/kuafu/mode.md) exhausts repo context before it asks one precise question.
- [Kua Fu recovery](../modes/kuafu/mode.md) tries a materially different hypothesis and consults Taishang before a third attempt.
- Decision gates ask a classifier first and escalate only when it is unsure ([ADR 0005](adr/0005-decision-gate-classifier-first-with-orchestrator-escalation.md)).
- Fu Xi turns intent into an approved plan; Hou Tu runs it ([orchestration guide](guides/orchistration.md)).

**Apply it:** Does this prompt or extension stop for the human for any reason other than authorization or scope only the human can grant, or missing access, credentials, or external state?

---

## Personal by Design

**Public to read, built for one user.**

Panda Harness fits one person's work ([README](../README.md), [root AGENTS.md](../AGENTS.md)). It makes no support, compatibility, or stability promises.

**Apply it:** Am I adding generality, compatibility, or configurability that only a hypothetical other user would need? YAGNI

---

## No Evidence, No Done

**Delegation does not replace verification.**

- A worker's report is a claim. The parent reads the changed files, reviews the diff against the request, and runs integration checks and QA itself ([Kua Fu](../modes/kuafu/mode.md); Hou Tu in the [orchestration guide](guides/orchistration.md)).
- Kua Fu's finish gate adds independent Spec and Standards review for refactors, migrations, security changes, and larger ultrawork changes; the parent keeps acceptance ([ADR 0006](adr/0006-kuafu-finish-gate-uses-two-isolated-review-axes.md)).
- Research follows the same rule. Claims need opened, cited sources, and the parent checks every cited URL against the researcher's source trace ([Wenchang](../agents/wenchang.md), [Kua Fu](../modes/kuafu/mode.md)).

**Apply it:** Before this agent reports done, what evidence has it opened or run itself?

---

## Specialists, One Owner

**Many hands, one accountable orchestrator; each worker answers to its parent.**

Orchestrator side:

- Mode Agents route work to leaf Subagents. Subagents do not delegate; nesting stays off unless an agent opts in with a `+` rule in `delegation` ([agent frontmatter](guides/agent-frontmatter.md)).
- Each worker gets one cohesive packet; implementation travels with its tests.
- Independent chunks run in parallel.
- The orchestrator keeps routing, review, and acceptance ([agent orchestration](guides/agent-orchestration.md), [mode-scoped delegation](specs/mode-scoped-subagent-delegation.md)).

Worker side:

- A Subagent owns one bounded outcome inside the scope it was given.
- Results, questions, and blockers go to the parent, never to the human or another channel ([communication contract](../extensions/subagents/src/prompts.ts)). The parent decides whether the human is needed, using the two escalation reasons.
- The report is evidence the parent can verify: `COMPLETED`, `PARTIAL` with a last-green anchor, or `BLOCKED` ([agent contracts](../agents/AGENTS.md)).
- Role, description, and tools agree: the model-visible description states the duty, and the tool allowlist grants only what that duty needs.

**Apply it:** Who owns acceptance, does each worker get one complete packet, and does each agent definition give one role, matching tools, and a report the parent can verify?

---

## Smallest Correct Change

**Agent code is indistinguishable from the code around it.**

- Follow existing patterns.
- Stay in scope; add no speculative abstraction.
- Prefer behavior-preserving changes.
- Reuse before writing: existing code, then the standard library, then installed dependencies.

See [README boundaries](../README.md) and the [extensions contract](../extensions/AGENTS.md).

**Apply it:** Could a reviewer tell an agent wrote this diff, and is every changed line needed?

---

## Tokens Buy Evidence

**Spend tokens before the human's attention.**

- Cost stays visible: see `reportUsage` and `showCost` in [subagents.json](../subagents.json).
- Every action buys evidence or progress.
- Before escalating, retry with a materially different strategy.
- Do small work directly when that is cheaper than delegating.
- Add an agent only when it cuts elapsed time or adds distinct coverage.
- Send quick, mechanical work to a fast worker.
- Stop research once the evidence is enough to decide ([Kua Fu](../modes/kuafu/mode.md)).

**Apply it:** What evidence or progress does this action buy, and is there a cheaper way to get it?

---

## Work Survives Interruptions

**Work resumes from durable state, not from the human's memory.**

- [Tasks](../extensions/tasks/README.md) and [goals](../extensions/goal/README.md) record what remains.
- Agent-tree `local://` storage holds scratch files and notepads ([session-local](../extensions/session-local/README.md), [ulw](../extensions/ulw/README.md)).
- Subagent sessions resume with their context ([subagents](../extensions/subagents/README.md)).

**Apply it:** If this session stopped now, could the next one continue from recorded state alone?

---

## Same Rules, Model-Fit Prompts

**Behavior is identical for every model family; only prompt style adapts.**

Prompt style adapts to documented model quirks ([model families](../modes/MODEL-FAMILIES.md)). The default `mode.md` is canonical for behavior; family variants restate it in a style that fits the model ([parity rule](../modes/MODEL-FAMILIES.md#parity-rule)).

**Apply it:** Does this variant change what the agent does, or only how the instruction is phrased?

---

## Code Is Truth

**What takes effect at runtime is the truth; text describes it.**

- Code is whatever takes effect at runtime: prompts, extension source, agent graphs, runtime config. Docs and comments are text and lose any conflict.
- A conflict between a prompt and extension code is a bug. Until it is fixed, the behavior the runtime enforces is truth.
- When a prompt rule keeps failing, enforce it in extension code. Typed agent graphs show the pattern: the runtime validates decisions, enforces budgets, bounds feedback loops, and checkpoints each transition ([bounded feedback](specs/agent-graph-bounded-feedback.md), [ADR 0002](adr/0002-remove-subagentworkflow-script-runtime.md), [ADR 0004](adr/0004-graph-actor-context-is-an-owned-mutable-aggregate.md)).
- Docs describe current code and link to it ([documentation rules](../AGENTS.md#documentation-rules)). A hierarchy of DOX `AGENTS.md` files binds each subtree.
- One vocabulary: [GLOSSARY.md](../GLOSSARY.md) ([ADR 0003](adr/0003-retire-workflow-terminology.md)).
- Borrow from upstream openly. Consequential divergences get an ADR ([ADR 0001](adr/0001-orchestration-sizing-follows-upstream-omo.md)); the [prompt parity spec](specs/mode-prompt-parity.md) tracks the rest.

**Apply it:** Does the runtime enforce this rule, and does every doc that mentions it match the code?

---

## The Core Loop

```
  human: state intent (approve the plan when there is one)
              |
              v
  +------------------------------+
  | orchestrator routes work     |
  |   -> specialists (parallel)  |<--+
  |   -> runtime enforces rules  |   | recover: new hypothesis,
  |   -> orchestrator verifies   |---+ consult, retry
  +------------------------------+
              |
              v
     verified evidence -> done

  human re-enters only on a valid escalation;
  any other stop becomes a harness fix
```

| Principle                        | Where it lives                                                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Intervention is a failure signal | [Kua Fu](../modes/kuafu/mode.md), [ADR 0005](adr/0005-decision-gate-classifier-first-with-orchestrator-escalation.md), [orchestration guide](guides/orchistration.md)                                                                                                                |
| Personal by design               | [README](../README.md), [root AGENTS.md](../AGENTS.md)                                                                                                                                                                                                                               |
| No evidence, no done             | [Kua Fu](../modes/kuafu/mode.md), [Wenchang](../agents/wenchang.md)                                                                                                                                                                                                                  |
| Specialists, one owner           | [agent orchestration](guides/agent-orchestration.md), [mode-scoped delegation](specs/mode-scoped-subagent-delegation.md), [agent frontmatter](guides/agent-frontmatter.md), [agent contracts](../agents/AGENTS.md), [communication contract](../extensions/subagents/src/prompts.ts) |
| Smallest correct change          | [README](../README.md), [extensions contract](../extensions/AGENTS.md)                                                                                                                                                                                                               |
| Tokens buy evidence              | [subagents.json](../subagents.json), [Kua Fu](../modes/kuafu/mode.md)                                                                                                                                                                                                                |
| Work survives interruptions      | [tasks](../extensions/tasks/README.md), [goal](../extensions/goal/README.md), [session-local](../extensions/session-local/README.md), [ulw](../extensions/ulw/README.md), [subagents](../extensions/subagents/README.md)                                                             |
| Same rules, model-fit prompts    | [model families](../modes/MODEL-FAMILIES.md), [parity rule](../modes/MODEL-FAMILIES.md#parity-rule)                                                                                                                                                                                  |
| Code is truth                    | [bounded feedback](specs/agent-graph-bounded-feedback.md), [GLOSSARY.md](../GLOSSARY.md), [prompt parity](specs/mode-prompt-parity.md), [ADR 0001](adr/0001-orchestration-sizing-follows-upstream-omo.md)                                                                            |

---

## What This Is Not

- Not a shared framework or template.
- Not a roadmap; it describes the harness as it is.

---

## Further Reading

- [Documentation index](README.md)
- [Orchestration guide](guides/orchistration.md)
- [Agent orchestration across modes](guides/agent-orchestration.md)
- [Modes](../modes/README.md)
- [Model families](../modes/MODEL-FAMILIES.md)
- [Glossary](../GLOSSARY.md)
