# Subagent Tool Output Presentation

**Status:** proposed

## Problem Statement

Panda Harness exposes Subagent work through three related tools: starting or resuming a Subagent, checking a background run, and steering a running Subagent. Their human-facing tool output does not yet form one coherent presentation system.

Collapsed output reports useful facts, but spreads status, activity, identity, model, usage, result previews, artifacts, and next actions across too many rows. Users must scan telemetry to answer simple questions: Is the Subagent still working? Did it finish? What did it produce? What should I do next?

Expanded output is complete but mostly presents raw model-facing text. Metadata repeats, final results lack visual hierarchy, errors compete with secondary details, and paths are difficult to scan. Steering output also lacks the custom presentation used by the other Subagent tools.

The interface needs progressive disclosure without changing the tool results consumed by the parent Agent. Collapsed output should support supervision at a glance. Expanded output should provide a readable, complete run report. The `/agents` interface should remain the interactive conversation viewer rather than being duplicated inside every tool row.

## Solution

Present all Subagent tool output through a consistent human-facing system:

- A compact call header identifies the operation, Subagent, and bounded task.
- A collapsed result uses no more than three visual lines to show lifecycle status and essential statistics, the most decision-relevant activity/result/error or next action, and an expand hint only when expansion reveals useful information.
- An expanded result renders a structured run report: status or error first, complete requested result content as readable Markdown, then secondary run metadata and artifacts.
- Starting or resuming a Subagent and checking its result share one run-report presentation model. Steering uses a smaller action-report renderer built from the same status, width, and theme conventions.
- Human-facing rendering consumes additive, JSON-safe presentation details derived from runtime state. It does not parse human prose when structured state is available.
- Model-facing `content`, `isError`, result-consumption timing, persistence, notifications, and public lifecycle/event contracts remain unchanged.
- If presentation details are absent, malformed, or from an older result, expanded rendering falls back to the original raw content instead of hiding information or failing the tool row.

This creates three deliberate disclosure levels:

1. Collapsed tool rows for fast supervision.
2. Expanded tool rows for complete run reports and explicitly requested verbose output.
3. `/agents` for interactive live conversation inspection and control.

## User Stories

1. As a user, I want to identify the Subagent and delegated task from the call header, so that I know what the row represents before reading its result.
2. As a user, I want a running Subagent's status, current activity, and elapsed time visible at a glance, so that I can tell whether work is progressing.
3. As a user, I want a queued Subagent clearly distinguished from a running one, so that waiting for capacity does not look like stalled execution.
4. As a user, I want background delivery distinguished from lifecycle status, so that “started in background” is not mistaken for completion.
5. As a user, I want a completed Subagent summarized with its result preview and useful statistics, so that I can often understand the outcome without expanding it.
6. As a user, I want graceful turn-limit completion described in plain language, so that an internal `steered` state does not look like manual steering or failure.
7. As a user, I want user-initiated or external stops distinguished from hard-limit aborts, so that I understand why work ended.
8. As a user, I want failures to show the decisive error before telemetry, so that diagnosis starts with the cause.
9. As a user, I want policy denials and invalid requests distinguished from Subagent runtime failures, so that I choose the correct recovery action.
10. As a user, I want a background acknowledgement to show the agent ID and next supervision action, so that I can continue the workflow immediately.
11. As a user, I want the collapsed result limited to a few lines, so that multiple concurrent Subagents remain scannable.
12. As a user, I want absent or zero-value statistics omitted, so that empty telemetry does not distract from meaningful state.
13. As a user, I want status expressed through text as well as color and symbols, so that the interface remains understandable without color perception.
14. As a user, I want the expand shortcut displayed only when expansion adds information, so that hints remain useful rather than repetitive.
15. As a user, I want long descriptions and previews truncated safely in collapsed mode, so that one run cannot dominate the terminal.
16. As a user, I want the expanded result to render the complete Subagent response as Markdown, so that headings, lists, code, and evidence remain readable.
17. As a user, I want the expanded report to put result content before secondary metadata after successful completion, so that the answer receives visual priority.
18. As a user, I want the expanded report to put current activity before metadata while work is active, so that live state receives visual priority.
19. As a user, I want the expanded report to put an error and recovery information before metadata after failure, so that I can respond quickly.
20. As a user, I want metadata grouped under a clear run section, so that model, thinking level, delivery mode, turns, tool uses, tokens, and duration are easy to scan.
21. As a user, I want artifact paths grouped separately and left selectable, so that I can open the full output or persisted session when needed.
22. As a user, I want expanded values wrapped rather than omitted, so that expansion never conceals requested content.
23. As a user, I want explicitly requested verbose conversation output preserved in the expanded result, so that expansion honors the tool call I made.
24. As a user, I want empty successful results distinguished from missing or malformed presentation data, so that silence is not confused with a renderer defect.
25. As a user, I want resumed work to state whether it continued live or restored a persisted session when that outcome is available, so that continuity is observable.
26. As a user, I want foreground and background runs to use the same lifecycle vocabulary, so that delivery mode does not change the meaning of status.
27. As a user, I want multiple Subagent rows to use consistent ordering and labels, so that I can compare runs quickly.
28. As a user, I want steering calls to identify their target and message preview, so that I can verify where guidance was sent.
29. As a user, I want steering results to distinguish delivered, rejected, missing-target, and failed outcomes, so that I know whether intervention took effect.
30. As a user, I want a truncated steering-message preview to remain complete in expanded mode, so that compact presentation does not lose my instruction.
31. As a narrow-terminal user, I want labels and values to stack or wrap safely, so that every rendered line fits the available width.
32. As a user working with CJK text, emoji, ANSI styling, long URLs, paths, and unbroken strings, I want width calculations based on visible terminal cells, so that borders and adjacent UI do not break.
33. As a user, I want code blocks and Markdown content readable at narrow widths, so that expansion remains useful outside wide desktop terminals.
34. As a user, I want semantic theme colors rather than hard-coded colors, so that output works across light, dark, and custom themes.
35. As a parent Agent, I want model-facing tool content to remain byte-for-byte unchanged, so that presentation work cannot alter reasoning or orchestration behavior.
36. As a parent Agent, I want existing `isError` behavior preserved, so that error handling does not depend on visual formatting.
37. As an orchestrator, I want agent IDs and next actions retained in model-visible output, so that supervision and resume flows continue to work.
38. As a maintainer, I want one structured presentation model for Subagent run reports, so that starting and checking a run cannot drift into different status semantics.
39. As a maintainer, I want presentation details separated into lifecycle status, invocation outcome, delivery mode, activity, result/error, statistics, and artifacts, so that internal enums are not overloaded for display.
40. As a maintainer, I want presentation details to be additive, serializable data without runtime or session objects, so that old results and extension boundaries remain compatible.
41. As a maintainer, I want malformed or missing details to fall back to raw content, so that renderer evolution cannot make results disappear.
42. As a maintainer, I want partial updates and final results rendered through the same state vocabulary, so that live rows do not jump between contradictory labels.
43. As a maintainer, I want aggregate usage labeled as tokens rather than context unless true context occupancy is measured, so that labels remain accurate.
44. As a maintainer, I want the `/agents` viewer to remain responsible for interactive transcript navigation and stopping, so that tool rows do not duplicate a deeper interface.
45. As a maintainer, I want durable output and session artifacts to remain available when transcript previews truncate individual tool results, so that complete evidence is recoverable.
46. As a maintainer, I want renderer tests to exercise public tool definitions and real terminal-width behavior, so that tests verify user-visible contracts rather than helper implementation.
47. As a maintainer, I want one real TUI check of collapsed-to-expanded behavior, so that component tests do not miss integration with Pi's expand action.
48. As an extension consumer, I want existing RPC and `subagents:*` event payloads preserved, so that presentation changes do not break other Extensions.

## Implementation Decisions

- The call header is the sole identity header. Expanded results do not repeat the Subagent name and task description unless raw fallback content requires it.
- A shared run-report presentation model separates lifecycle status, invocation outcome, delivery mode, activity, result or error, statistics, continuation state, and artifacts. Background is a delivery mode, not a lifecycle status.
- Human labels map lifecycle outcomes explicitly: queued, running, completed, completed at turn limit, stopped, aborted by hard limit, and failed. Invocation outcomes such as background start, live resume, restored-session resume, policy denial, and missing target remain distinct from lifecycle state.
- Starting or resuming a Subagent and checking a Subagent result use one run-report renderer. Their adapters populate the same presentation model from authoritative runtime state.
- Steering uses a dedicated action-report renderer because it reports delivery of an instruction rather than a Subagent run result. It follows the same status, theme, width, fallback, and expand-hint conventions.
- Structured presentation details are additive and JSON-safe. They contain no live session, runtime, provider, component, or other non-serializable objects.
- Model-facing `content` remains byte-for-byte unchanged for every state and tool. `isError`, result consumption, notification delivery, persistence, resume behavior, RPC behavior, and public lifecycle events also remain unchanged.
- Expanded “lossless” means all content requested by the tool call remains visible in the rendered component. It does not require byte-identical visual formatting. Markdown may change styling and wrapping but may not omit text.
- Missing, malformed, or unsupported presentation details trigger a safe raw-content fallback. Renderer failure must not hide the result or crash the containing tool row.
- Collapsed `renderResult` output uses at most three visual lines: status plus essential statistics; one decision-relevant activity, result, error, identifier, or next-action line; and an expand hint when useful. The call header is separate from this limit.
- Collapsed mode may truncate previews and secondary identifiers to fit. Expanded mode provides complete values and artifacts. If a shortened identifier is shown collapsed, the complete identifier is available expanded.
- Status always includes readable text. Icons and semantic theme colors reinforce status but never carry meaning alone.
- Running and partial results prioritize current activity. Successful terminal results prioritize the complete result. Failed terminal results prioritize error and recovery information. Metadata follows the primary content.
- Aggregate input/output/cache usage is labeled `tokens`. The interface uses `context` only for measured context-window occupancy.
- Empty and zero-value metadata is omitted. Empty successful output receives an explicit, quiet empty-result message rather than being confused with missing details.
- Expanded output uses lightweight section headings and separators inside Pi's existing tool container. It does not add a nested outer border.
- Metadata uses aligned labels when width permits and stacked labels when it does not. Artifact paths and URLs remain selectable and wrap without semantic truncation in expanded mode.
- Every rendered line respects visible terminal-cell width after ANSI styling. Width handling covers CJK text, emoji, combining characters, long unbroken strings, paths, URLs, Markdown, and code blocks.
- The configured expand-action key hint is used instead of hard-coding a shortcut. The hint appears only when expanded mode reveals additional content.
- `/agents` remains the interactive live-conversation surface, including navigation and stop controls. Expanded tool output remains a report, not an embedded interactive viewer.
- Explicit verbose result requests remain complete in expanded output even though `/agents` owns interactive transcript viewing. Durable output/session artifacts remain the recovery path for content that other preview surfaces intentionally bound.
- No new public event or RPC contract is introduced. Any future public payload change requires the repository's existing approval process and backward-compatible versioning.

## Testing Decisions

- Tests assert external presentation behavior: visible hierarchy, status vocabulary, complete expanded content, collapsed line budget, width safety, fallback behavior, and unchanged model-facing results. They do not assert private helper calls or internal object layout.
- The primary seam is the registered tool-definition contract. Tests capture the actual registered Subagent tools, call `renderCall` and `renderResult` with the same options Pi supplies, and render the returned component at real terminal widths. This is the highest seam that covers tool adapters, shared presentation data, theme behavior, partial/final state, expanded/collapsed disclosure, and width handling together.
- One shared table exercises run-report rendering for both starting/resuming and checking a Subagent. Thin adapter tests verify that each tool supplies correct structured presentation data without duplicating renderer assertions.
- Steering receives focused contract tests for call preview, delivered result, rejected or missing target, failure, truncation, expansion, and raw fallback.
- State coverage includes queued, running partial, foreground completion, background acknowledgement, background completion, completed at turn limit, stopped, hard-limit abort, runtime error, policy denial, missing agent, live resume, restored-session resume, empty output, and malformed details.
- Collapsed tests assert no more than three result lines, omission of zero statistics, decision-relevant ordering, conditional expand hints, safe preview truncation, and complete identifiers in expanded mode.
- Expanded tests assert status/error-first hierarchy, complete Markdown result text, metadata and artifact grouping, verbose conversation preservation, empty-result messaging, and raw-content fallback.
- Compatibility tests capture model-facing `content` and `isError` before and after presentation changes and assert byte-for-byte equality for every tool/state fixture.
- Width tests render at 8, 20, 40, 80, and 120 columns with CJK text, emoji, combining characters, ANSI styling, long unbroken text, long paths, URLs, Markdown, and code blocks. Every returned line must fit its visible width. Expanded values may wrap but may not use semantic ellipsis.
- Theme tests use semantic theme roles and confirm that status still includes readable text when color is absent.
- Partial-result tests confirm that live updates and final output use consistent status semantics and that progress updates do not replace authoritative final content.
- Prior art includes existing Subagent tool-renderer tests, summary-renderer width tests, live activity projection tests, conversation-viewer tests, result-recovery tests, and extension session-context integration tests.
- One real Pi TUI scenario starts a background Subagent, captures collapsed output, toggles the configured expand action, captures expanded output, checks width and hierarchy, then checks completion or failure presentation. The capture verifies Pi integration rather than replacing component contract tests.
- Focused Extension tests, type checking, and the repository's Extension smoke suite remain required implementation gates.

## Out of Scope

- Changing prompts, Subagent behavior, model selection, thinking levels, tool permissions, or orchestration policy.
- Changing model-facing tool content, error semantics, result consumption, notification timing, persistence, session restoration, or resume behavior.
- Changing public `subagents:*` events, RPC contracts, or cross-Extension lifecycle semantics.
- Redesigning the `/agents` widget, conversation viewer, stop confirmation, scrolling, or transcript storage.
- Adding a new interactive transcript viewer inside expanded tool rows.
- Changing output-file or session-file retention.
- Changing Pi's global tool container, global expand action, theme system, Markdown renderer, or terminal-width implementation.
- Adding provider-specific telemetry or speculative statistics.
- Displaying hidden reasoning or internal chain-of-thought.
- General visual redesign of unrelated Extension tools.

## Further Notes

Taishang found no architectural blocker. The review identified four requirements that must remain explicit during implementation: presentation data must come from typed runtime state rather than parsed prose; lifecycle state must remain separate from delivery and invocation outcomes; expanded losslessness means complete visible content with raw fallback rather than byte-identical styling; and every line must obey visible terminal width under real Unicode and ANSI conditions.

The design intentionally favors a quiet collapsed row and a readable expanded report. Complete interactive history remains available through `/agents`, while durable output and session artifacts preserve deeper evidence. This avoids turning every tool result into a second conversation viewer.
