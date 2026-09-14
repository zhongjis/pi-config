# Workflow Tool and Notification Presentation

Status: shipped

## Problem Statement

Pi users cannot reliably tell what a SubagentWorkflow produced or which Subagents ran from its current transcript presentation. A completed object result appears as `Completed · {`. The collapsed activity row selects only the first currently active task, so all child identity disappears on completion; even while running, the task label does not identify the configured Subagent type. Expanded reports mix the answer with repeated identity, per-child telemetry, prompts, previews, and logs. Completion notifications foreground usage and retain only a 500-character preview, so expansion cannot recover the answer.

The reported `graph-engineering-research` run completed four of four agents in 138.124 seconds; all journal entries had successful, nonempty results. The first declared task was `eigent`, using `wenchang`. Its returned object had `research` and `review` fields. This was a presentation defect, not evidence of skipped work. Execution success does not establish research accuracy.

## Solution

The tool row supervises execution. The notification announces the outcome. Both expand into trustworthy, state-specific reports. Keep one workflow identity header, meaningful result summaries, explicit lifecycle text, and a lasting task-label/Subagent-type roster. Put resource usage only in expanded reports. Preserve complete retained output and make any omission explicit and recoverable.

The following mockups reproduce the accepted final proposal. Values are illustrative except the recorded run facts above. `[expand]` represents the configured Pi expansion binding, never literal UI copy. Placeholder paths mean complete existing paths; placeholders for JSON mean the actual complete returned content, not explanatory text in the product. Spacing adapts to terminal width.

### Tool — collapsed, completed

```text
▸ SubagentWorkflow · graph-engineering-research
  Completed · structured result
  4 agents completed · fields: research, review
  [expand] result · /agents › Workflows
```

### Tool — collapsed, running

```text
▸ SubagentWorkflow · graph-engineering-research
  Running · 3 active
  eigent · wenchang · +2 active tasks
  [expand] details · /agents › Workflows
```

Show the first active task label and configured Subagent type, plus the other active-task count. Completed agents never masquerade as current activity. Strings use meaningful returned text; objects use structural summaries, never an opening brace. Counts describe observed work, not a predetermined total. Queued work is distinguished from active work.

### Tool — expanded

```text
▸ SubagentWorkflow · graph-engineering-research
  Completed · 4 agents completed

  Result
    <complete returned JSON, formatted and wrapped>

  Agents
    Research
      Completed  eigent               wenchang
      Completed  primary-sources      wenchang
      Completed  our-runtime          chengfeng
    Review
      Completed  architecture-review  taishang

  Run
    ID       wf_5ccf65c9439b
    Duration 2m 18s
    Usage    33 tools · 157,021 tokens

  Artifacts
    Script   <full existing script path>
    Result   <full existing result path>

  /agents › Workflows — inspect agents and conversations
```

The roster remains visible after completion. Do not repeat the workflow heading or interleave prompt dumps and telemetry into the roster. Preserve retained child details and logs in a clearly separated appendix unless an equally recoverable destination exists. The inspector alone is not durable storage. Running expansion prioritizes activity; failed expansion prioritizes the decisive error and supported recovery.

### Notification — collapsed

```text
Workflow completed · graph-engineering-research
  4 agents completed · returned research, review
  [expand] result · /agents › Workflows
```

No tokens or tools compete with the outcome, and completion is explicit text rather than an icon alone.

### Notification — collapsed, child failure

```text
Workflow completed with agent errors · <name>
  1 agent failed · returned result available
  [expand] result and diagnostics
```

Script failure remains `Workflow failed`, distinct from a completed script with child errors. This labels execution facts, not whether the user's broader task succeeded.

### Notification — expanded

```text
Workflow completed · graph-engineering-research

  Result
    <complete returned JSON>

  Agents
    eigent               wenchang   Completed
    primary-sources      wenchang   Completed
    our-runtime          chengfeng   Completed
    architecture-review  taishang   Completed

  Run
    wf_5ccf65c9439b · 2m 18s
    33 tools · 157,021 tokens

  Full result
    <full existing result path>
```

If display remains bounded, disclose the exact omission and working full-output route. Never label a 500-character snapshot “full result.” If the source or artifact is unavailable, say so instead of promising recovery.

## User Stories

1. As a Pi user, I want one stable workflow call header, so that I can identify a run without repeated headings.
2. As a Pi user, I want collapsed tool results limited to three physical rows, so that concurrent work does not dominate scrollback.
3. As a Pi user, I want a meaningful preview of returned text, so that completion tells me what was produced.
4. As a Pi user, I want objects and arrays described structurally, so that an opening brace or bracket never stands in for a result.
5. As a Pi user, I want object field names shown where space permits, so that I can recognize a structured answer without fabricated prose.
6. As a Pi user, I want empty successful results identified explicitly, so that silence is not mistaken for renderer failure.
7. As a Pi user, I want active and queued task counts distinguished, so that waiting for capacity does not look like execution.
8. As a Pi user, I want counts to represent observed work, so that dynamically discovered agents do not invalidate a promised denominator.
9. As a Pi user, I want the first active task label and Subagent type shown together, so that I know both what is happening and who is doing it.
10. As a Pi user, I want concurrent activity summarized with an additional-active count, so that a single label does not hide parallel work.
11. As a Pi user, I want finished tasks removed from current activity, so that stale labels do not imply ongoing execution.
12. As a Pi user, I want a complete expanded task-label/type/status roster after completion, so that I can verify which Subagents ran.
13. As a Pi user, I want tool rosters grouped by phase, so that task identity retains its workflow context.
14. As a Pi user, I want explicit Running, Paused, Stopped, Failed, and Completed labels, so that status remains understandable without color.
15. As a Pi user, I want child errors distinguished from script failure, so that a successfully returned script is not represented as universal child success.
16. As a Pi user, I want skipped, blocked, interrupted, and replayed work represented truthfully, so that incomplete or reused work is not counted as fresh success.
17. As a Pi user, I want running reports to prioritize activity, so that I can supervise current work.
18. As a Pi user, I want completed reports to put the full result first, so that the answer takes precedence over telemetry.
19. As a Pi user, I want failed reports to put the error and supported recovery first, so that I can act on the failure.
20. As a Pi user, I want complete strings rendered readably and structured results formatted as JSON, so that expansion preserves the returned answer.
21. As a Pi user, I want prompts, retained child previews, effective model/thinking data, and logs separated from the compact roster, so that evidence remains accessible without obscuring the result.
22. As a Pi user, I want retained details preserved unless an equally recoverable destination exists, so that visual simplification does not destroy information.
23. As a Pi user, I want the inspector to remain the interactive conversation/control surface, so that every tool row does not become another application.
24. As a Pi user, I want full run IDs and actual artifact paths expanded, so that I can locate the script and saved result.
25. As a Pi user, I want notification previews to prioritize outcome rather than usage, so that completion messages remain useful at a glance.
26. As a Pi user, I want expanded notifications to retain full returned answers independently of live task lookup, so that a short preview is not mistaken for complete content.
27. As a Pi user, I want any remaining omission quantified with a valid recovery route or explicit unavailability, so that expansion is honest.
28. As a Pi user, I want artifact-write failures visible, so that a nonexistent full-result file is not advertised.
29. As a Pi user, I want the configured expansion shortcut shown only when useful, so that disclosure remains discoverable and accurate.
30. As a narrow-terminal user, I want status and decisive errors preserved before secondary facts, so that width constraints do not hide what matters.
31. As a Unicode/ANSI user, I want terminal-cell-safe wrapping and clipping, so that CJK, emoji, combining characters, paths, and styled text fit every row.
32. As a Pi user, I want usage, tools, duration, and model diagnostics only expanded, so that collapsed views remain quiet.
33. As a Pi user, I want legacy or malformed presentation data to fall back to original content, so that renderer evolution cannot hide valid results.
34. As the parent Agent, I want model-facing result and notification content, error flags, execution, timing, and resume semantics unchanged, so that a visual redesign cannot alter orchestration.
35. As a maintainer, I want tests through registered tool and message renderers plus real Pi captures, so that verification covers the user-facing seams rather than only formatter internals.
36. As a Pi user, I want unavailable historical live state identified honestly, so that a reload is not presented as continued live supervision or durable recovery.

## Implementation Decisions

- Keep the existing call/result separation. The call header owns workflow identity; standalone notifications and workflow entries carry their own identity. The immediate background acknowledgement is not final completion, and live state comes from the current workflow task rather than only the partial-result flag.
- Reuse the workflow progress projection to derive observed counts and child display states. Keep scheduled-so-far distinct from fixed total, and configured Subagent type distinct from task label, runtime handle, and conversation record ID. Omit unavailable identity rather than inventing a type.
- Use explicit lifecycle text with semantic theme colors as reinforcement. Paused workflows may still have active children. Distinguish failed, skipped, blocked, interrupted, and cached/replayed children, preserving their underlying execution semantics and error flags.
- For successful strings use meaningful returned text; for absent/empty output show an empty state; for objects and arrays show structural summaries and available keys/counts. Do not infer natural-language outcomes from arbitrary object fields or fall back to stale activity logs on terminal success.
- Collapsed tool results have at most three physical rows excluding the call header. Collapsed workflow notifications have at most three physical rows including their identity header. Prefer state and decisive error before secondary facts at narrow widths. Omit collapsed usage telemetry. Use configured expansion hints and existing inspector navigation.
- Expanded tool reports order Activity/Result/Error before the phase-grouped identity roster, Run metadata, actual artifacts, and a separately labeled retained-details/log appendix. Expanded notifications order outcome, complete result, compact roster, Run, and existing full-result path. No nested outer boxes or repeated tool identity headings.
- Preserve complete retained return content. Render strings as readable Markdown and objects/arrays as formatted JSON. Wrap expanded values and full paths instead of silently ellipsizing them. Keep retained child details and logs in an appendix; moving them elsewhere requires an equally recoverable route, not merely a live inspector or a journal that does not contain them.
- Extend workflow-specific presentation data additively with serializable identity, complete retained result, progress/aggregate facts, run metadata, and actual artifact outcomes. Reuse the existing notification channel with an optional workflow payload; ordinary Agent notifications keep their behavior.
- Capture existing full-result artifact-write success/failure as structured data, without parsing model-facing prose, adding writes, or changing their timing. Render only actual paths and report write failures. A retained full result remains readable even when its artifact write fails.
- Persist only plain presentation snapshots where the existing entry/notification path already persists data. Missing live tasks retain the existing honest raw acknowledgement fallback unless a supported snapshot is already available. This feature does not promise new session restoration, retention, or post-expiry inspector access.
- Preserve model-facing content byte-for-byte, existing error flags, execution, notification timing and follow-up behavior, usage accounting, public lifecycle events, and resume semantics. No new model calls, inferred summaries, dependencies, or execution controls.

## Testing Decisions

The user approved the existing public verification seams: capture the registered workflow tool and notification renderer, invoke their render methods as Pi does, then exercise a fresh Pi session through interactive_shell with real workflow children.

Tests assert externally visible behavior and unchanged model-facing payloads, not private helper calls or mutable prompt prose. Prior art includes workflow registration/rendering tests, generic notification tests, serialized workflow-entry tests, and native Pi TUI width tests.

Required cases:

- The reported object result with `research` and `review`: no brace-only collapsed preview; all four task labels and Subagent types survive expanded completion.
- Running-to-terminal transitions, concurrent first-active identity and extra-active count, queued and paused states, stopped/interrupted work, script failure, completed script with child errors, skipped/blocked/replayed children.
- Strings, arbitrary objects, arrays, null/absent/empty results, no agents, long field names, and stale logs after successful empty completion.
- Notification results over 500 characters and over the existing model-facing truncation threshold; late/tail content remains available expanded; successful artifact creation and write failure both have truthful routes/diagnostics.
- Complete retained per-child previews, effective model/thinking metadata, and logs remain in the expanded appendix after serialization. Missing live task, legacy entries, malformed workflow payload, generic Agent notifications, and raw/empty fallback remain safe.
- Configured expansion hints, useful disclosure, no duplicated identity, and no collapsed tools/tokens/duration telemetry.
- Widths 0, 1, 2, 8, 20, 40, 80, and 120 with CJK, emoji, combining characters, ANSI, CR/LF, unbroken paths, JSON, and Markdown. Every line fits terminal-cell width; collapsed limits apply after rendering.
- Model-facing content and error flags remain unchanged; completion is delivered once through the existing follow-up path and timing; no new side effects or changes to child scheduling/resume.
- Focused tests, extension type checking, relevant lint/static checks, and real Pi interactive-shell captures of collapsed/expanded tool and notification states, including a failure or long-result case. Inspect the workflow inspector, child order, and completion evidence; clean up temporary sessions and processes.

## Out of Scope

- Changing workflow execution, scripts, scheduling, model selection, permissions, schemas used by child agents, gates, replay/resume, notification timing, or model-facing content.
- Redesigning the inspector, fleet widget, conversation viewer, global Pi expansion, theme system, or unrelated tools/ordinary Agent notifications.
- Adding durable workflow recovery, extending session retention, adding automatic summaries/model calls, or inventing recovery guarantees.
- Creating new artifacts solely to avoid showing retained details; existing writes and their failure behavior stay unchanged.

## Further Notes

Taishang approved the proposal as feasible with four corrections now included: separate task/type identity; distinguish script completion from child success; add structured notification details instead of trying to recover discarded previews; and preserve retained information without relying on expired live state.

The native renderer probe reproduced the brace and missing terminal label using the actual recorded result and reconstructed progress. Its running/expanded controls retained the task label. This is source/runtime evidence, not a historical screenshot replay.

The user selected repository delivery instead of issue-tracker publication. This spec is the authoritative accepted scope; implementation steps and verification evidence belong in the [implementation plan](../guides/workflow-presentation-implementation.md), not as weaker replacements for these requirements.
