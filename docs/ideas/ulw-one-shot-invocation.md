# OMO-aligned one-shot ULW invocation

Status: idea

Tracker: https://github.com/zhongjis/pi-config/issues/8

## Problem Statement

Invoking `ulw` currently behaves like a one-shot instruction at runtime but looks like a session-level mode in the terminal. Activation shows a success notification and adds a persistent footer status that is never cleared, while the Ultrawork directive is delivered as a hidden custom context message rather than as part of the triggering user prompt. Users cannot reliably infer whether Ultrawork applies to one request, every later request, or the whole session.

This differs from upstream OMO's bare `ulw` contract: keyword invocation is turn-scoped, the full directive is prepended to the triggering user prompt, and activation uses temporary feedback rather than persistent mode chrome. Persistent autonomous repetition is a separate concept and must not be implied by bare `ulw`.

## Solution

Make bare `ulw` an explicit, one-shot prompt invocation aligned with OMO semantics. When a user includes a supported Ultrawork trigger in a Kua Fu prompt, Pi removes the trigger, prepends the model-family-specific Ultrawork directive to that same submitted user prompt, and processes one normal agent run. The terminal gives concise temporary activation feedback but does not add persistent footer status.

Keep invocation semantics distinct from session modes and autonomous loops. Bare `ulw` must not persist activation state, inject the directive into later prompts, start a continuation loop, or alter `/mode` state. Existing trigger protections, Kua Fu gating, model-family prompt selection, and normal Pi continuation behavior remain intact.

## User Stories

1. As a Pi user, I want `ulw` to apply to the prompt where I invoke it, so that its lifetime is predictable.
2. As a Pi user, I want `ultrawork` to behave the same as `ulw`, so that both documented triggers are interchangeable.
3. As a Pi user, I want the Ultrawork directive prepended to my submitted task, so that the model receives one ordered user prompt matching OMO semantics.
4. As a Pi user, I want the trigger token removed from the task text, so that it is not mistaken for task content.
5. As a Pi user, I want only the first valid trigger removed, so that unrelated later text is preserved.
6. As a Pi user, I want concise temporary activation feedback, so that I know invocation was recognized.
7. As a Pi user, I do not want an Ultrawork footer after a one-shot invocation, so that the UI does not imply session persistence.
8. As a Pi user, I want later prompts to run normally unless they also invoke Ultrawork, so that behavior never leaks across turns.
9. As a Pi user, I want bare `ulw` to remain distinct from `/mode`, so that turn instructions do not silently change my active persona.
10. As a Kua Fu user, I want Ultrawork invocation to remain available, so that implementation work can opt into higher rigor.
11. As a non-Kua Fu mode user, I want `ulw` text left untouched, so that mode-specific behavior is not activated unexpectedly.
12. As a Pi user, I want `ulw` inside inline code or fenced code ignored, so that examples and documentation do not activate it.
13. As a Pi user, I want existing `<ultrawork-mode>` blocks ignored as triggers, so that injected or quoted directives do not recursively activate Ultrawork.
14. As a Pi user, I want `@ulw` and extension path references ignored, so that resource references are not treated as invocation keywords.
15. As a Pi user, I want case-insensitive keyword recognition, so that common capitalization variants work consistently.
16. As a Pi user, I want word-boundary matching, so that words containing `ulw` or `ultrawork` are not altered.
17. As a Pi user, I want a bare trigger with no task to retain existing empty-task behavior, so that the change does not invent a new workflow.
18. As a Pi user, I want attached images preserved when text is transformed, so that multimodal prompts remain intact.
19. As a Pi user, I want GPT-family models to receive the GPT Ultrawork directive, so that existing model-specific guidance remains effective.
20. As a Pi user, I want other model families to receive the default Ultrawork directive, so that current fallback behavior remains stable.
21. As a Pi user, I want one directive injection per valid invocation, so that retries, internal messages, and repeated hooks do not duplicate large prompts.
22. As a Pi user, I want extension-originated and internal continuation messages excluded from keyword activation, so that agent wake-ups cannot recursively enter Ultrawork.
23. As a Pi user, I want normal Pi tool and continuation behavior after invocation, so that Ultrawork changes instructions rather than inventing a second execution engine.
24. As a maintainer, I want the transformed prompt to be observable at the extension boundary, so that tests can prove directive order and task preservation.
25. As a maintainer, I want UI feedback tested independently from model prompt content, so that visual changes cannot silently alter context semantics.
26. As a maintainer, I want no persisted activation entry or session flag for bare `ulw`, so that resume, fork, and reload cannot revive one-shot state.
27. As a maintainer, I want existing mode gating and trigger sanitization retained, so that alignment does not broaden activation scope.
28. As a maintainer, I want real-runtime coverage of one-shot behavior, so that unit mocks are not the only proof.
29. As a maintainer, I want adjacent `/mode` behavior to remain unchanged, so that persistent personas continue to use their existing system-prompt and footer contracts.
30. As a maintainer, I want autonomous looping treated as a separate product contract, so that one-shot prompt alignment stays small and reviewable.

## Implementation Decisions

- Bare `ulw` and `ultrawork` are turn-scoped invocation keywords, not session modes.
- Invocation remains gated to Kua Fu. Other modes pass input through unchanged.
- Existing protected regions and resource-reference exclusions remain part of trigger detection.
- Trigger processing transforms the submitted user prompt before agent processing. It removes the first valid trigger and prepends the selected Ultrawork directive before the remaining task text.
- The directive and task are delivered as one user prompt. A hidden custom context message is no longer used for Ultrawork instructions.
- Model-family prompt selection remains unchanged: GPT-family models use GPT-specific instructions; other families use default instructions.
- Activation feedback is temporary. No persistent footer status, widget, session entry, or active-mode indicator is created.
- Bare invocation does not modify active `/mode`, active tools, model selection, task DAG state, or session metadata beyond the normal submitted prompt.
- Invocation does not start an autonomous continuation loop. Normal Pi agent/tool continuation remains responsible for completing the turn.
- Internal, synthetic, and extension-originated messages must not retrigger keyword detection.
- Reload, resume, fork, and later user prompts must not reconstruct or inherit bare Ultrawork activation.
- Documentation must describe Ultrawork as an invocation, avoiding language such as “session mode” or persistent “activation.”

## Testing Decisions

- Prefer the highest existing seam: the real Pi runtime integration harness should submit a Kua Fu prompt containing `ulw` and assert that the model-facing user prompt begins with the selected Ultrawork directive, contains the preserved task, and produces no persistent Ultrawork status.
- Keep focused extension unit coverage for trigger parsing, protected regions, first-match removal, Kua Fu gating, model-family selection, input transformation, temporary notification, and absence of persistent status.
- Test external behavior rather than closure flags or hook registration details. Assertions should target transformed prompt content, invocation count, UI calls, and later-turn behavior.
- Add a sequential-turn regression: one prompt invokes `ulw`; the next ordinary prompt must contain no Ultrawork directive and receive no activation feedback.
- Add an internal-message regression: synthetic or extension-originated text containing `ulw` must not activate or inject the directive.
- Add an adjacent-surface regression proving persistent `/mode` status and system-prompt behavior remain unchanged.
- Preserve existing extension smoke coverage to prove the extension still loads through normal discovery.
- Prior art is the existing Ultrawork extension unit suite for trigger and prompt-family behavior, the existing Ultrawork integration suite using the real Pi test harness, and mode integration tests for persistent mode behavior.

## Out of Scope

- Implementing `/ulw-loop` or any Ralph-style autonomous repetition engine.
- Adding new session states, retry counters, completion detectors, stop commands, or loop persistence.
- Changing Kua Fu, Fu Xi, Hou Tu, Lu Ban, or Shen Nong mode contracts.
- Changing Ultrawork directive wording beyond placement required for prompt transformation.
- Changing model routing, active tools, delegation policy, task DAG behavior, goal mode, autoresearch, or Boomerang.
- Reproducing OMO-specific OpenCode hooks, Ralph Loop internals, or model override behavior.
- Redesigning Pi's general skill-command or prompt-template rendering.

## Further Notes

`ulw-loop` is potentially useful, but it should be a separate spec and explicit command rather than an extension of bare `ulw`. A safe loop needs a durable lifecycle contract: objective, bounded iteration policy, completion signal, maximum iterations or budget, stop/cancel command, session reload/resume behavior, failure backoff, internal-message protection, visible active-state UX, and guaranteed cleanup. Current local task DAG semantics and one-shot ULW state do not provide that contract directly. Implement one-shot alignment first; evaluate a loop only after choosing whether Pi Goal, Boomerang, or a new dedicated loop state machine owns those responsibilities.
