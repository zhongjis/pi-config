# Workflow Tool and Notification Presentation

Status: shipped

## Problem Statement

The original presentation defect hid SubagentWorkflow results and child identity: a completed object appeared as `Completed · {`, terminal activity lost the roster, expanded output mixed answers with telemetry, and notification expansion could not recover the complete answer. The 2026-09-16 amendment also addresses silent child failures and domain rejection presented as successful completion.

The reported `graph-engineering-research` run completed four of four agents in 138.124 seconds; all journal entries had successful, nonempty results. The first declared task was `eigent`, using `wenchang`. Its returned object had `research` and `review` fields. This was a presentation defect, not evidence of skipped work. Execution success does not establish research accuracy.

## Solution

The tool row supervises execution. The notification announces the outcome. Both expand into trustworthy, state-specific reports. Keep one workflow identity header, meaningful result summaries, explicit lifecycle text, and a lasting task-label/Subagent-type roster. Put resource usage only in expanded reports. Preserve complete retained output and make any omission explicit and recoverable.

These mockups describe the current shipped contract, including the 2026-09-16 failure/outcome amendment. Values are illustrative except the recorded run facts above. The legacy research return has no declared outcome. `[expand]` represents the configured Pi expansion binding, never literal UI copy. Placeholder paths mean complete existing paths; JSON placeholders mean complete returned content. Spacing adapts to terminal width.

### Execution and objective outcome

- Execution lifecycle and declared objective outcome are independent. A normal script return completes execution, not necessarily the user's objective. Execution failure takes presentation precedence.
- Required `agent()` calls reject on terminal provider, schema-result, or gate failure. `{optional:true}` returns null only for ordinary terminal failures; policy, configuration, programming, and fatal errors still reject. User skips remain null, including required calls.
- Thrown `parallel` thunks and `pipeline` stages reject orchestration. A null stage result short-circuits that item's remaining pipeline stages; false, 0, and empty strings remain valid. Direct dependent calls MUST handle user-skip null explicitly.
- `outcome.succeed(value?)`, `outcome.partial(reason, value?)`, and `outcome.fail(reason, value?)` declare objective outcome explicitly. Partial/failed reasons MUST be nonblank. Arbitrary payload fields such as `accepted:false` are NEVER inferred; plain legacy returns show `Outcome not declared`.
- Helpers shallow-freeze the reserved `$subagentWorkflowOutcome` envelope and metadata, not user values. Root returns normalize outcome separately from payload; nested calls retain envelopes for explicit propagation. Malformed envelopes fail execution. Optional persisted outcome keeps legacy snapshots valid; malformed snapshots retain raw fallback.
- Model-facing completion notifications intentionally disclose outcome, `Execution: ...`, and completed/failed/skipped child counts. Delivery timing/channel, one-owner follow-up, usage, replay/resume, permissions, and artifact behavior remain preserved.

### Tool — collapsed, completed

```text
▸ SubagentWorkflow · graph-engineering-research
  Outcome not declared · structured result
  Execution: completed · 4 agents completed · fields: research, review
  [expand] result and diagnostics · /agents › Workflows
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
  Outcome not declared · 4 agents completed
  Execution: completed

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
Workflow outcome not declared · graph-engineering-research
  Execution: completed · 4 agents completed · returned research, review
  [expand] result and diagnostics · /agents › Workflows
```

No tokens or tools compete with the outcome, and completion is explicit text rather than an icon alone.

### Notification — collapsed, explicit outcome and child failures

```text
Workflow outcome partial: optional evidence missing · <name>
  Execution: completed · 1 agent completed · 1 agent failed · 1 agent skipped
  [expand] result and diagnostics · /agents › Workflows
```

An explicit `outcome.fail('verification_failed', value)` instead displays `Workflow outcome failed: verification_failed · <name>` even when every child completed. Uncaught required child/script failure displays `Workflow execution failed · <name> · <error>`; it does not become a completed workflow with a missing result. Optional failures and user skips remain independently visible in child counts. A normal plain return with child errors still has `Outcome not declared`, not inferred objective success.

### Notification — expanded

```text
Workflow outcome not declared · graph-engineering-research · 4 agents completed
Execution: completed

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
14. As a Pi user, I want explicit execution and declared-outcome labels, so that status remains understandable without color and completion never implies acceptance.
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
34. As the parent Agent, I want explicit required/optional failure handling and outcome/execution/settlement notification fields, while delivery timing/channel, usage, replay/resume, and permissions remain preserved.
35. As a maintainer, I want tests through registered tool and message renderers plus real Pi captures, so that verification covers the user-facing seams rather than only formatter internals.
36. As a Pi user, I want unavailable historical live state identified honestly, so that a reload is not presented as continued live supervision or durable recovery.
37. As a Pi user, I want one stable phase-grouped inspector roster, so that opening details or changing selection does not relocate agents between panes.
38. As a Pi user, I want inspector rows to show only the effective runtime model, so that requested model chains are not mistaken for the model actually running; unresolved sessions say `model pending`.
39. As a wide-terminal user, I want roster and selected-agent details side by side; as a narrow-terminal user, I want an explicit detail view with a reliable back action.
40. As a Pi user, I want running details to lead with current activity and terminal details to lead with outcome or error, so that the decisive state appears first.
41. As a Pi user, I want concise default controls and contextual supervision controls, so that navigation stays readable without hiding pause, skip, retry, stop, or conversation access.
42. As a Pi user, I want unavailable live detail identified honestly, so that the inspector does not fabricate timelines, tool names, dependencies, or future agent rows.

## Implementation Decisions

- Keep the existing call/result separation. The call header owns workflow identity; standalone notifications and workflow entries carry their own identity. The immediate background acknowledgement is not final completion, and live state comes from the current workflow task rather than only the partial-result flag.
- Reuse the workflow progress projection to derive observed counts and child display states. Keep scheduled-so-far distinct from fixed total, and configured Subagent type distinct from task label, runtime handle, and conversation record ID. Omit unavailable identity rather than inventing a type.
- Use explicit lifecycle and declared-outcome text with semantic colors. Paused workflows may still have active children. Distinguish failed, skipped, blocked, interrupted, and cached/replayed children; child settlement is not objective acceptance.
- For successful strings use meaningful returned text; for absent/empty output show an empty state; for objects and arrays show structural summaries and available keys/counts. Do not infer natural-language outcomes from arbitrary object fields or fall back to stale activity logs on terminal success.
- Collapsed tool results have at most three physical rows excluding the call header. Collapsed workflow notifications have at most three physical rows including their identity header. Prefer state and decisive error before secondary facts at narrow widths. Omit collapsed usage telemetry. Use configured expansion hints and existing inspector navigation.
- Expanded tool reports order Activity/Result/Error before the phase-grouped identity roster, Run metadata, actual artifacts, and a separately labeled retained-details/log appendix. Expanded notifications order outcome, complete result, compact roster, Run, and existing full-result path. No nested outer boxes or repeated tool identity headings.
- Preserve complete retained return content. Render strings as readable Markdown and objects/arrays as formatted JSON. Wrap expanded values and full paths instead of silently ellipsizing them. Keep retained child details and logs in an appendix; moving them elsewhere requires an equally recoverable route, not merely a live inspector or a journal that does not contain them.
- Extend workflow-specific presentation data additively with serializable identity, complete retained result, progress/aggregate facts, run metadata, and actual artifact outcomes. Reuse the existing notification channel with an optional workflow payload; ordinary Agent notifications keep their behavior.
- Capture existing full-result artifact-write success/failure as structured data, without parsing model-facing prose, adding writes, or changing their timing. Render only actual paths and report write failures. A retained full result remains readable even when its artifact write fails.
- Persist only plain presentation snapshots where the existing entry/notification path already persists data. Missing live tasks retain the existing honest raw acknowledgement fallback unless a supported snapshot is already available. This feature does not promise new session restoration, retention, or post-expiry inspector access.
- Extend model-facing completion text intentionally with outcome, execution, and child settlement. Preserve payload content, existing tool error flags, notification timing/follow-up, usage accounting, public lifecycle events, permissions, and replay/resume mechanics. Required/optional failure handling changes only as specified above; no new model calls, inferred summaries, dependencies, or execution controls.
- The live inspector uses one phase-grouped roster with selection keyed by stable workflow entry index. Wide terminals keep roster and state-first detail side by side; narrow terminals drill into detail and use explicit back navigation. Resizing preserves selection.
- Inspector rows show explicit lifecycle text and only effective session `modelId`; queued or started-but-unresolved work says `model pending`, replayed work says `model not run`, and terminal work without session metadata says `model unavailable`. Requested chains and requested/effective discrepancies remain in expanded diagnostics, not the supervision roster.
- Declared empty phases remain visible as scheduling placeholders, but agents not yet emitted by the runtime are never invented. Detail uses retained aggregate facts and previews only. Default help stays concise; valid pause/resume, skip, retry, stop, conversation, and paging controls are contextual.

## Testing Decisions

The user approved the existing public verification seams: capture the registered workflow tool and notification renderer, invoke their render methods as Pi does, then exercise a fresh Pi session through interactive_shell with real workflow children.

Tests assert externally visible behavior, explicit outcome/failure contracts, and preserved payload/delivery invariants, not mutable prompt prose. Public seams include workflow registration/rendering, serialized workflow entries, fixture-host execution, and native Pi TUI width tests.

Required cases:

- The reported object result with `research` and `review`: no brace-only collapsed preview; all four task labels and Subagent types survive expanded completion.
- Running-to-terminal transitions; execution failure versus declared failed/partial/succeeded outcome; undeclared legacy returns; required rejection and downstream suppression; optional null, skips, falsy pipeline results, thrown orchestration, nested outcomes, and malformed envelopes. Retain queued/paused/stopped, blocked/interrupted, and replayed-child coverage.
- Strings, arbitrary objects, arrays, null/absent/empty results, no agents, long field names, and stale logs after successful empty completion.
- Notification results over 500 characters and over the existing model-facing truncation threshold; late/tail content remains available expanded; successful artifact creation and write failure both have truthful routes/diagnostics.
- Complete retained per-child previews, effective model/thinking metadata, and logs remain in the expanded appendix after serialization. Missing live task, legacy entries, malformed workflow payload, generic Agent notifications, and raw/empty fallback remain safe.
- Configured expansion hints, useful disclosure, no duplicated identity, and no collapsed tools/tokens/duration telemetry.
- Widths 0, 1, 2, 8, 20, 40, 80, and 120 with CJK, emoji, combining characters, ANSI, CR/LF, unbroken paths, JSON, and Markdown. Every line fits terminal-cell width; collapsed limits apply after rendering.
- Model-facing notification extensions disclose outcome/execution/settlement without changing returned payload, tool error flags, one-owner follow-up timing/channel, usage, permissions, artifact behavior, or replay/resume. Required failure intentionally stops dependent work.
- Focused tests, extension type checking, relevant lint/static checks, and real Pi interactive-shell captures of collapsed/expanded tool and notification states, including a failure or long-result case. Inspect the workflow inspector, child order, and completion evidence; clean up temporary sessions and processes.
- Inspector tests cover stable selection while progress grows, phase placeholders, every display state, effective-model/pending rules, wide/narrow transitions, state-first detail, contextual controls, timer disposal/settlement, overlay conversation restoration, and the same width matrix.

## Out of Scope

- Changes beyond the shipped failure/outcome amendment: unrelated scheduling, model selection, permissions, child schemas, gate commands, replay/resume mechanics, notification timing/channel, or payload rewriting. Required/optional execution semantics and corresponding notification disclosure are explicitly in scope.
- Redesigning the fleet widget, conversation viewer, global Pi expansion, theme system, or unrelated tools/ordinary Agent notifications.
- Adding durable workflow recovery, extending session retention, adding automatic summaries/model calls, or inventing recovery guarantees.
- Creating new artifacts solely to avoid showing retained details; existing writes and their failure behavior stay unchanged.

## Further Notes

The original presentation review required task/type identity, distinction between script completion and child success, structured notification snapshots, and retained information independent of expired live state. The 2026-09-16 amendment adds required-by-default failure handling and explicit objective outcomes without relaxing those presentation requirements.

The native renderer probe reproduced the brace and missing terminal label using the actual recorded result and reconstructed progress. Its running/expanded controls retained the task label. This is source/runtime evidence, not a historical screenshot replay.

The user selected repository delivery instead of issue-tracker publication. This spec is the authoritative accepted scope; implementation steps and verification evidence belong in the [implementation plan](../guides/workflow-presentation-implementation.md), not as weaker replacements for these requirements.
