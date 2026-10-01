# Goodbye Slop; Welcome Determinism

Status: idea

Source: David Khourshid, [“Goodbye Slop; Welcome Determinism”](https://www.youtube.com/watch?v=1rMgw0Q5MgY), Agent Conf.

This non-binding note summarizes Khourshid's proposal for combining deterministic agent workflows with generative models.

## Core thesis

AI agents become more reliable when control flow lives in explicit, deterministic state machines instead of large prompts. Models should handle flexible work such as drafting and interpretation, while code enforces rules, states, and permitted transitions.

## Key points

- **Unstructured delegation creates “slop.”** Large prompts ask models to generate content, remember rules, make judgments, invoke tools, and control workflows at the same time. As context grows, these instructions become harder to inspect, test, and trust.

- **Determinism applies to the process, not generated content.** A model may still produce different text for the same request. The surrounding system can still define which states exist, which transitions are allowed, and which guards must pass.

- **The email agent separates rules from generation.** Its rules require it to draft before sending, send only after approval, and never invent a recipient. States such as drafting, reviewing, needing a recipient, sending, sent, and cancelled make invalid actions structurally unavailable.

- **Explicit workflows improve observability.** Developers can trace states and events instead of inspecting only a long conversation. The trace shows where runs diverge and where users encounter unnecessary friction.

- **Evaluations should cover paths and outcomes.** An agent may complete its task while still creating a poor user experience. Evaluate individual steps, transitions between steps, and the final outcome.

- **Agents can propose workflow improvements.** A separate agent can inspect the state machine, execution traces, and evaluations, then propose a revised machine. Comparable scenarios can test both versions. In the email example, the revised workflow drafts sooner and asks for missing information during review, reducing repetitive questions.

- **Deterministic orchestration still uses generative models.** The workflow can call an LLM, invoke tools, or perform asynchronous work within explicit state boundaries. The state machine controls what may happen next.

- **XState is optional.** A reducer, switch statement, or another explicit transition mechanism can implement the same principle. XState and Stately add visualization, tooling, and structured execution.

- **Not every agent needs a formal state machine.** Use one when explicit structure replaces confusion, especially for approval flows, safety rules, tool execution, and multi-step tasks.

## Practical takeaway

Keep non-negotiable behavior in code through states, transitions, and guards. Let models perform open-ended reasoning within those boundaries. Record execution traces, evaluate both the route and the result, then compare workflow revisions under equivalent scenarios.
