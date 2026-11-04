# Manifesto

The principles and philosophy behind Panda Harness.

Project reality check:

- One user's [Pi](https://github.com/mariozechner/pi-coding-agent) coding-agent harness: Mode Agents, Subagents, Extensions, and typed agent graphs.
- Personal by design: public to read, built for one user. No support, compatibility, or stability promises, and no generality only a hypothetical other user would need.
- These principles are adopted from the [oh-my-openagent manifesto](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/manifesto.md). Where this harness works differently, the section says so.

---

## Human Intervention is a Failure Signal

**HUMAN IN THE LOOP = BOTTLENECK**

Think about autonomous driving. When a human has to take over the wheel, that's not a feature. It's a failure of the system. The car couldn't handle the situation on its own.

**Why is coding any different?**

When you find yourself:

- Fixing the agent's half-finished work
- Manually correcting obvious mistakes
- Guiding the agent step-by-step through a task
- Repeatedly clarifying the same requirements

That's not "human-AI collaboration." That's the agent failing to do its job.

**Panda Harness is built on this premise**: human intervention during agentic work is fundamentally a wrong signal. If the system is designed correctly, the agent completes the work without requiring you to babysit it.

In this harness:

- **The human is the only counterpart.** Every message that reaches the harness is the human's. The harness has no notion of who or what typed it.
- **Intent is not intervention.** Stating what to build, changing your mind, answering an interview you asked for, and approving a plan are intent.
- **The harness stops for the human for exactly two reasons:** authority or scope only the human can grant, or missing access, credentials, or external state. Every other stop is a harness defect: fix the prompt, contract, or runtime that caused it.

---

## Indistinguishable Code

**Goal: Code written by the agent should be indistinguishable from code written by a senior engineer.**

Not "AI-generated code that needs cleanup." Not "a good starting point." The actual, final, production-ready code.

This means:

- Following existing codebase patterns exactly
- Proper error handling without being asked
- Tests that actually test the right things
- No AI slop (over-engineering, unnecessary abstractions, scope creep)
- Comments only when they add value

If you can tell whether a change was made by a human or an agent, the agent has failed.

---

## Token Cost vs Productivity

**Higher token usage is acceptable if it significantly increases productivity.**

Using more tokens to:

- Have multiple specialized agents research in parallel
- Get the job done completely without human intervention
- Verify work thoroughly before completion
- Retry with a materially different strategy before asking the human

That's a worthwhile investment when it means 10x, 20x, or 100x productivity gains.

**However:**

Unnecessary token waste is not pursued. The system optimizes for:

- Doing small work directly when that is cheaper than delegating
- Sending quick, mechanical work to a fast, cheap worker
- Adding an agent only when it cuts elapsed time or adds distinct coverage
- Stopping research when sufficient evidence is gathered
- Keeping cost visible

Token efficiency matters. But not at the cost of work quality or human cognitive load.

---

## Minimize Human Cognitive Load

**The human should only need to say what they want. Everything else is the agent's job.**

Two approaches achieve this:

### Approach 1: Fu Xi → Hou Tu (Interview Mode)

You say: "I want to add authentication."

Fu Xi:

- Researches your codebase to understand existing patterns
- Asks clarifying questions based on actual findings
- Surfaces edge cases you hadn't considered
- Documents decisions as you make them
- Produces a complete, reviewed plan that Hou Tu executes

**You provide intent. The agent provides structure.**

### Approach 2: Kua Fu (Just Do It Mode)

You say: "add authentication", or "ulw add authentication" for ultrawork.

Kua Fu:

- Figures out the right approach
- Researches what it needs
- Implements following conventions
- Verifies everything works
- Keeps going until complete

**You provide intent. The agent handles everything.**

In both cases, the human's job is to **express what they want**, not to manage how it gets done.

---

## Predictable, Continuous, Delegatable

**The ideal agent should work like a compiler**: intent goes in, working results come out.

### Predictable

Given the same inputs:

- Same codebase patterns
- Same requirements
- Same constraints

The output should be consistent. Not random, not surprising, not "creative" in ways you didn't ask for.

In this harness, a prompt asks and the runtime guarantees: a rule that keeps failing in a prompt moves into extension code, where it is enforced. Prompts adapt to each model family, but the contracts they carry do not change.

### Continuous

Work should survive interruptions:

- Session crashed? Tasks and goals record what remains.
- Need to step away? Notepads and scratch files persist in session-local storage.
- Worker stopped mid-task? Resume it with its context.

A session exists to settle one task: any problem with a done condition, coding or not. The session is only a container; the task outlives it through recorded state. The agent maintains state. You don't have to.

### Delegatable

Just like you can assign a task to a capable team member and trust them to handle it, you should be able to delegate to the agent.

This means:

- Clear acceptance criteria, verified independently: a worker's "done" is a claim, and the parent opens the changes and runs the checks itself
- One accountable owner per task, with specialists working in parallel underneath
- Self-correcting behavior when something goes wrong
- Escalation (to Taishang, to the human) only when truly needed
- Complete work, not "mostly done": every task settles as complete, partial with a resume point, or blocked, each with evidence

---

## The Core Loop

```
Human Intent → Agent Execution → Verified Result
       ↑                              ↓
       └──────── Minimum ─────────────┘
          (intervention only on true failure)
```

Everything in Panda Harness is designed to make this loop work:

| Feature | Purpose |
| ------- | ------- |
| [Fu Xi](../modes/fuxi/default.md) | Extract intent through interview; produce a reviewed plan |
| [Hou Tu](../modes/houtu/default.md) | Execute an approved plan |
| [Kua Fu](../modes/kuafu/default.md) | Classify intent, route work, verify evidence, accept |
| [Ultrawork](../extensions/ulw/README.md) | Intensify Kua Fu to keep going until verified complete |
| [Specialist Subagents](guides/agent-orchestration.md) | One role and one bounded outcome per worker, in parallel |
| [Taishang](../agents/taishang/default.md) | Consultation on hard decisions before a third failed attempt |
| [Finish gate](adr/0006-kuafu-finish-gate-uses-two-isolated-review-axes.md) | Independent Spec and Standards review of consequential changes |
| [Decision gates](adr/0005-decision-gate-classifier-first-with-orchestrator-escalation.md) | Classifier first; escalate only when unsure |
| [Typed agent graphs](specs/agent-graph-bounded-feedback.md) | Runtime-enforced decisions, budgets, and bounded feedback |
| [Tasks](../extensions/tasks/README.md) and [goals](../extensions/goal/README.md) | Record what remains; prevent "I'm done" lies |
| [Session-local storage](../extensions/session-local/README.md) | Notepads and scratch files that survive the session |
| [Resumable Subagents](../extensions/subagents/README.md) | Continue a worker with its context |
| [Usage and cost display](../subagents.json) | Keep token spend visible |
| [Model families](../modes/MODEL-FAMILIES.md) | Model-fit prompts carrying shared contracts |

---

## What This Means in Practice

**You should be able to:**

1. Describe what you want (high-level or detailed, your choice)
2. Let the agent interview you if needed
3. Confirm the plan (or just let Kua Fu handle it)
4. Walk away
5. Come back to completed, verified work, or to one precise question only you can answer

**If you can't do this, something in the system needs to improve.**

---

## The Future We're Building

A world where:

- The human focuses on **what** to build, not **how** to get the agent to build it
- Work quality is independent of who (or what) did it
- Complex problems are as easy as simple ones (they just take longer)
- "Prompt engineering" becomes as obsolete as "compiler debugging"

**The agent should be invisible.** Not in the sense that it's hidden, but in the sense that it just works. You flip the switch. The light turns on.

That's the goal.

---

## Further Reading

- [Documentation index](README.md)
- [Orchestration guide](guides/orchistration.md)
- [Agent orchestration across modes](guides/agent-orchestration.md)
