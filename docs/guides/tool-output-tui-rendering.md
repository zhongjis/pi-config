# Tool Output TUI Rendering Guide

Practical guidance for agents implementing human-facing Pi tool calls and tool results.
The goal is readable supervision at a glance, useful detail on demand, and no change
to what the model receives.

This guide covers tool presentation. It does not define tool execution semantics,
result schemas, or global Pi TUI behavior.

For the concrete Subagent presentation contract, see
[`docs/specs/subagent-tool-output-presentation.md`](../specs/subagent-tool-output-presentation.md).

---

## Start with the three output concerns

A Pi tool has related but separate concerns:

```text
tool arguments
  ├─ renderCall(...)                       → human call header
  └─ execute(...)
       ├─ content                          → model/session
       ├─ details                          → structured presentation data
       └─ renderResult(..., { expanded,
                              isPartial }) → human result
```

Keep these boundaries explicit:

- `content` is the model-facing result. Presentation work must not silently rewrite it.
- `details` carries structured facts needed by the renderer. Prefer serializable data,
  not live sessions, providers, components, or other runtime objects.
- `renderCall` identifies the operation and its important arguments.
- `renderResult` presents progress and outcome independently of model-facing prose.
- `isPartial` means the result is still changing. Render activity, not a terminal outcome.
- `expanded` is disclosure state. It does not mean the tool ran differently.

**Collapse is not truncation.** Collapse hides human-facing detail without changing the
tool result. Truncation changes available content and must occur deliberately before the
result reaches the model. Name the omitted scale and preserve a route to the full artifact
when one exists. If execution discarded the source data, state that full output is unavailable.

---

## Design for progressive disclosure

Use three information levels:

1. **Call header** — What operation is running, against what target?
2. **Collapsed result** — What is its current or final state, and does the user need to act?
3. **Expanded result** — What happened, what was returned, and where is deeper evidence?

A separate viewer may own interactive logs, transcripts, scrolling, or process control.
Do not recreate that viewer inside every expanded tool row. Expanded output is a report,
not automatically a second application.

### Collapsed mode

Collapsed output is a decision view. Usually show no more than three rendered rows:

1. Status plus essential statistics.
2. Current activity, result preview, decisive error, identifier, or next action.
3. Expand hint, only when expansion reveals useful information.

The row budget applies **after wrapping**, not to logical newline count.

```text
▸ search "renderResult" in extensions/
├─ ✓ completed · 18 matches · 240ms
└─ Ctrl+O details
```

```text
▸ Agent · Audit tool rendering
├─ ● running in background · reading renderer tests · 24s
├─ id: 7cb5b424 · next: check with get_subagent_result
└─ Ctrl+O details
```

Examples in this guide show Pi's current default expand binding. Renderers must resolve
the configured `app.tools.expand` key hint instead of embedding `Ctrl+O`.

Omit zero values and unavailable metadata. Do not spend rows on `0 tools`, `0 tokens`,
unknown duration, or labels that add no decision value.

### Expanded mode

Expanded output is a structured report. It shows all content retained for human rendering.
Any remaining omission names its scale and full-output route. Order sections by state:

- **Successful terminal result:** result first, then run metadata and artifacts.
- **Running result:** current activity first, then available run metadata.
- **Failed result:** error and recovery first, then diagnostics and artifacts.
- **Background acknowledgement:** identifier and next action first, then configuration.

Use lightweight headings and separators inside Pi's existing tool container. Avoid a
nested outer box.

The fixed separators and aligned metadata below assume a wide viewport. Implementations
derive separator length from the supplied width and stack metadata when it does not fit.

```text
✓ Completed                                             1m 08s
  4 turns · 12 tools · 35.9k tokens · sonnet

Result
────────────────────────────────────────────────────────
Found three presentation gaps:

• Collapsed output is telemetry-heavy
• Expanded output duplicates metadata
• Steering output lacks custom rendering

Run
────────────────────────────────────────────────────────
ID        7cb5b424
Mode      foreground
Thinking  high

Artifacts
────────────────────────────────────────────────────────
Output    /tmp/pi-subagents/…/task.output
Session   ~/.pi/agent/subagent-sessions/…
```

Expanded does not justify duplication. If the call header already identifies the tool,
target, and description, do not repeat that identity as another large heading.

---

## Use a presentation model

Render from structured state instead of parsing human-facing `content`. A useful model
separates concepts that are often incorrectly overloaded:

```typescript
interface ToolPresentation {
  lifecycle: "queued" | "running" | "terminal";
  outcome?: "completed" | "stopped" | "aborted" | "failed" | "denied" | "missing";
  invocation?: "started" | "resumed" | "restored";
  acknowledgement?: "delivered";
  completionReason?: "normal" | "turn-limit";
  delivery?: "foreground" | "background";
  activity?: string;
  result?: string;
  error?: { message: string; recovery?: string };
  stats?: {
    durationMs?: number;
    turns?: number;
    toolUses?: number;
    tokens?: number;
  };
  artifacts?: Array<{ label: string; path: string }>;
  truncated?: { shown: number; total: number; unit: "lines" | "items" | "bytes" };
}
```

Adapt this shape to the tool. Do not introduce fields that cannot occur.

Important distinctions:

- Background is a delivery mode, not a lifecycle state.
- Queued is not running.
- Invocation, acknowledgement, and terminal outcome are separate facts.
- Completion at a configured limit is an outcome plus completion reason, not failure.
- User stop, external stop, hard-limit abort, policy denial, and runtime failure are
  different outcomes and may require different recovery text.
- Aggregate usage is `tokens`; use `context` only for measured context-window occupancy.

When structured details are absent, malformed, or from an older result, fall back to the
original text. A renderer must not make a valid result disappear.

---

## Write status as a state transition

Use short, truthful, action-oriented labels:

| State | Good label | Emphasis |
|---|---|---|
| Queued | `Queued · waiting for a slot` | Why it has not started |
| Running | `Running · searching tests` | Current meaningful activity |
| Completed | `Completed` | Result preview or result body |
| Limit completion | `Completed at turn limit` | Partial/complete result truthfully |
| Stopped | `Stopped by user` or known actor | Recovery or resumability |
| Aborted | `Aborted at hard limit` | Limit and retained artifacts |
| Failed | `Failed` | Decisive error and next action |
| Denied | `Denied by policy` | Relevant policy or allowed alternative |

Change the verb when state changes:

```text
● Searching  →  ✓ Found 18 matches
● Running    →  ✓ Completed
● Writing    →  ✗ Failed to write
```

Do not leave a completed operation visually labeled `Running`. Do not use an animated
spinner as the only evidence of progress. When possible, show meaningful activity such
as `reading tests`, `waiting for approval`, or `running typecheck`.

---

## Match the renderer to the tool class

### Read and query tools

The call header should show query/target. Collapsed result should show count and
truncation state. Expanded result should show the most useful records.

```text
▸ rg "renderResult" in extensions/
└─ ✓ 18 matches · truncated
```

```text
✓ 18 matches

extensions/foo/index.ts:42: renderResult(...)
extensions/bar/tool.ts:18: renderResult(...)
… +16 lines

Full output: /tmp/pi-rg-…/output.txt
```

### Command tools

Show the command in the call header. Final collapsed output should emphasize exit state,
duration, and output size. Expanded output should preserve command/output distinction.

```text
▸ $ pnpm test subagent
└─ ✗ exit 1 · 38s · 146 lines
```

```text
✗ Failed                                                38s

Command
────────────────────────────────────────────────────────
pnpm test subagent

Error
────────────────────────────────────────────────────────
Expected rendered row width <= 40; received 43.

Output
────────────────────────────────────────────────────────
<relevant output, with any omission disclosed>
```

For long command output, head plus tail is often more useful than head alone. Include an
explicit omitted count between them.

### Mutation tools

The call header should identify the target. Collapsed result should describe the state
change, not echo full input. Expanded output should use the richest native representation,
such as a diff.

```text
▸ edit extensions/foo/index.ts
└─ ✓ +14 / -6
```

Errors must say what did not change. Never render a failed mutation as applied.

### Long-running and background tools

Collapsed output should answer: running or waiting, doing what, for how long, and how to
supervise it. Expanded output may include configuration and artifact paths, but live
transcript navigation belongs in the dedicated viewer when one exists.

```text
▸ Agent · Audit tool rendering
├─ ◦ queued · waiting for capacity
├─ id: 7cb5b424
└─ Ctrl+O details
```

```text
▸ Agent · Audit tool rendering
├─ ✗ failed after 38s · 2 turns · 5 tools
├─ TypeError: invalid presentation details
└─ Ctrl+O diagnostics
```

### Action and acknowledgement tools

Tools that send instructions or change control state need a compact confirmation, not a
run report.

```text
▸ steer_subagent · 7cb5b424 · "Focus on renderer consistency"
└─ ✓ steering message delivered
```

If the message preview is truncated, expansion should reveal the complete instruction.

---

## Handle long output explicitly

Long output has two independent budgets:

1. **Model budget:** enforced during execution. The model must be told when its result is
   incomplete and where full output can be read. If execution discarded the source data,
   label source truncation and state that full output is unavailable.
2. **Display budget:** enforced by the renderer. Collapsed presentation may omit detail;
   expanded presentation shows all renderer-retained content or explicitly names any
   remaining omission and its full-output route.

Good omission markers carry quantity:

```text
… +37 lines
… 128 of 2,430 matches shown
[truncated: 20/143 lines · full output: /tmp/tool-output.txt]
```

Avoid:

```text
...
more output
results omitted
```

These hide scale and recovery.

Treat empty output as a real state:

```text
✓ completed · no output
```

Distinguish it from missing details, malformed results, or renderer failure.

---

## Treat width as a correctness requirement

Every rendered line must fit the width supplied to the component. Test visible terminal
cells, not JavaScript string length.

Account for:

- ANSI escape sequences, which have zero visible width.
- CJK characters and emoji, which may occupy multiple cells.
- Combining characters.
- Prefixes, gutters, icons, and tree branches.
- Long paths, URLs, hashes, commands, and other unbroken text.
- Markdown and code blocks after wrapping.

Recommended behavior:

- Wrap before applying rendered-row limits.
- Measure the final prefixed/styled line.
- Use aligned label/value metadata only when width permits.
- Stack labels and values at narrow widths.
- Truncate collapsed previews safely.
- Wrap expanded values; do not silently ellipsize semantic content.
- Keep ANSI styles line-local because TUI lines are rendered independently.

At extremely narrow widths, preserve state text before telemetry. `Failed` matters more
than model name; `Running` matters more than token count.

---

## Build production-safe components

Tool-result renderers should usually remain passive. Use an interactive component, overlay,
or persistent widget only when users need navigation, filtering, scrolling, input, or
ongoing status that cannot fit a historical tool row.

### Width-safe helpers

Prefer Pi's width-aware helpers over string length:

- `visibleWidth` for final terminal-cell measurement.
- `truncateToWidth` for collapsed previews and framed rows.
- `wrapTextWithAnsi` for preserving ANSI state while wrapping.
- `matchesKey` for fixed `Key.*` input matching.
- An injected `KeybindingsManager` for configurable actions and displayed bindings.

A framed row must normalize width, flatten multiline content, then reserve border width
before truncation and pad the remaining interior:

```typescript
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function frameRow(content: string, width: number, theme: Theme): string {
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const singleLine = content.replace(/\r\n?|\n/g, " ");

  if (safeWidth === 0) return "";
  if (safeWidth === 1) return truncateToWidth(singleLine, 1, "");

  const innerWidth = safeWidth - 2;
  const clipped = truncateToWidth(singleLine, innerWidth, "");
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
  return theme.fg("border", "│") + clipped + padding + theme.fg("border", "│");
}
```

At width `1`, an indivisible two-cell grapheme may yield an empty line; never split it or
overflow the supplied width. At width `2`, an empty framed row is `││`. Treat this as a
minimum pattern, not a universal box abstraction. Tool rows already have Pi-owned chrome;
reserve custom borders for overlays and standalone panels.

Guard `wrapTextWithAnsi` at widths narrower than the widest indivisible grapheme. Measure
every wrapped result and use `truncateToWidth` to omit any grapheme that cannot fit rather
than returning an over-width line.

Guard all arithmetic. A progress bar must handle `total <= 0`, non-finite values,
`current > total`, and widths smaller than its fixed labels. At very narrow widths, replace
the bar with compact text rather than constructing a negative-width fill.

### Lifecycle, invalidation, and redraw

Keep Pi's lifecycle concepts separate:

- `Component.invalidate()` clears render caches. It does not request a redraw.
- `ToolRenderContext.invalidate()` schedules the containing tool row to redraw.
- Custom UI surfaces request redraw through `tui.requestRender()` or their injected
  `requestRender()` handle.

Components that subscribe, poll, debounce, cache themed lines, or own child processes need
explicit ownership:

- Prefer event-driven updates. Poll only for information that genuinely changes with time,
  such as elapsed duration.
- Throttle or coalesce frequent extension-side updates, then call the appropriate redraw API
  described above. Pi does not provide a generic render scheduler.
- Clear intervals, timeouts, subscriptions, listeners, and child resources when the surface
  closes or the session changes.
- `unref()` may stop an optional Node.js timer from keeping the process alive; it does not
  replace cleanup.
- Every custom `Component` implements `invalidate()`. Use a no-op for stateless components;
  otherwise clear or rebuild cached theme- or width-dependent output.
- Ignore scheduled callbacks after disposal; they must not request another render.

Custom `setWidget` components may implement `dispose()`; Pi invokes it when the widget is
replaced, cleared, or reset. Tool-result components have no generic disposal hook, so avoid
long-lived resources there or own cleanup through the extension's `session_shutdown` path.
For overlays and other custom surfaces, verify the owning API's disposal contract and test
that cleanup runs.

### Scrolling and follow mode

Interactive viewers should keep scroll behavior predictable:

- Derive width from `render(width)`. Do not substitute terminal column globals.
- Recompute viewport height when terminal dimensions change.
- Clamp cursor and scroll offsets after filtering, completion, or data removal.
- Auto-follow only while the user is already at the end.
- Disable auto-follow when the user scrolls upward; restore it on End or when they return to
  the final row.
- Use `matchesKey` for fixed `Key.*` controls. For configurable actions, use the injected
  `KeybindingsManager.matches()` and display bindings through `getKeys()` or `keyHint()`.
- Report position or remaining content when the viewport hides rows.

Tool-result expansion itself should not become focusable merely to support long text. Use an
existing transcript/output viewer when that surface already owns scrolling and control.

### Persistent widget ownership

A persistent widget is useful when background work must remain visible after its original
tool row scrolls away. Keep responsibilities separate:

- The historical tool row records invocation and result.
- The widget summarizes current background state.
- The overlay or viewer owns interactive transcript navigation and stop controls.

Hide the widget when it has nothing useful to report. Summarize overflow instead of growing
without bound. Clearing or replacing a `setWidget` component invokes its `dispose()`; still
remove the widget explicitly during extension/session teardown.

### Defensive formatting

Reusable formatters still need domain guards:

- Shorten a home path only at a path-segment boundary; `/home/alice2` is not inside
  `/home/alice`.
- Reject or normalize negative and non-finite token, cost, duration, and progress values.
- Use pluralization based on the displayed value.
- Keep duration based on monotonic elapsed time where runtime code supplies it.
- Preserve complete paths in expanded output or artifacts even when collapsed output uses
  `~`, basenames, or middle truncation.

---

## Use restrained, redundant visual cues

Status must remain understandable without color:

```text
● Running
✓ Completed
✗ Failed
◦ Queued
■ Stopped
```

Pair symbol, text, and semantic theme color. Never encode status with color alone. Avoid
hard-coded colors; use the active theme's semantic roles.

Other rules:

- Do not dim the entire result body. Primary content needs normal contrast.
- Reserve strong error color for the decisive error, not every diagnostic line.
- Keep icons aligned across stacked rows.
- Avoid decorative indicators when no state or action needs attention.
- Prefer stable text when animation is disabled or unsupported.
- Do not use symbols whose width or meaning is uncertain without a text label.

---

## Make expansion discoverable

Resolve `app.tools.expand` through Pi's keybinding APIs; do not hard-code a shortcut.
Use `getKeys()` or `keyHint()` for displayed bindings, and show the hint only when expansion
adds meaningful content.

```text
└─ Ctrl+O details
```

The concrete label may vary by result:

- `details` for metadata and artifacts.
- `full result` for complete result text.
- `diagnostics` for errors and recovery.
- `diff` for mutation details.

Avoid adding a user preference until the default behavior proves insufficient. A compact
default plus explicit expansion is usually enough.

---

## Preserve failure and fallback paths

A robust renderer follows this order:

1. If partial, render truthful live activity.
2. If failed, render error and recovery first.
3. If structured details are valid, render the appropriate presentation.
4. If details are absent or invalid, render raw text safely.
5. If content is empty, render an explicit empty state.
6. If rendering itself cannot proceed, use a minimal text fallback rather than throwing.

Errors should answer:

- What failed?
- What state was left behind?
- Can the operation be retried, resumed, or inspected?
- Where are complete diagnostics or artifacts?

Do not print an unexplained stack trace by default. Keep deep diagnostics reachable in
expanded output or an artifact.

---

## Anti-patterns

Avoid these patterns:

- **Raw dump by default:** model-facing prose is not an information hierarchy.
- **Metadata before result:** users usually care about outcome before model or token data.
- **Silent truncation:** an ellipsis without omitted scale or recovery path is misleading.
- **Parsing presentation prose:** derive rendering from structured details instead.
- **Color-only state:** inaccessible and ambiguous in monochrome terminals.
- **Internal enum labels:** translate implementation names into user-facing outcomes.
- **Background as status:** background describes delivery, not whether work is queued,
  running, or finished.
- **Nested boxes:** Pi already owns the outer tool container.
- **All-dim expanded output:** hierarchy disappears when everything is secondary.
- **Hard-coded shortcut text:** keybindings are configurable.
- **Auto-expanding every success:** global expansion can flood the transcript.
- **Duplicated transcript viewer:** link to or preserve the deeper inspection surface.
- **Zero telemetry:** omit facts that convey no information.
- **Logical-line limits:** wrapping can turn one logical line into many terminal rows.
- **Unsafe helper snippets:** padding without truncation, fixed-width separators, and
  unguarded progress arithmetic can overflow or throw.
- **Unowned refresh work:** timers, subscriptions, or scheduled renders that survive their
  component leak resources and redraw stale UI.

---

## Implementation sequence

1. Characterize existing `content`, `details`, `isError`, partial updates, and expanded
   output before changing presentation.
2. Define the smallest structured presentation model needed by the tool.
3. Implement the call header.
4. Implement terminal states and partial state separately.
5. Implement collapsed hierarchy and rendered-row budget.
6. Implement expanded state-specific sections.
7. Add raw, empty, and malformed-detail fallbacks.
8. Verify width, theme, Unicode, ANSI, and key-hint behavior.
9. Exercise the real Pi TUI in both collapsed and expanded states.

Do not refactor execution while changing rendering unless the tool contract requires new
additive details. Keep presentation changes isolated from side effects.

---

## Verification contract

Prefer the highest public seam: capture the registered tool definition, call
`renderCall`/`renderResult` as Pi does, then render the returned component at a supplied
width.

### Required behavior coverage

- Partial/running and final transition.
- Queued, completed, stopped, aborted, failed, denied, and missing-target states that the
  tool can actually produce.
- Foreground and background delivery when supported.
- Empty result, malformed details, and raw fallback.
- Long result with explicit omission and artifact recovery.
- Expanded result retains all renderer-retained content and discloses source/display
  truncation plus the available full-output route.
- Expand hint appears only when useful.
- Model-facing `content` and `isError` remain unchanged.
- Interactive/persistent surfaces clean up timers, subscriptions, listeners, and widgets.
- Scroll offsets remain valid after resize, filtering, completion, and data removal.

### Width matrix

Render at representative widths such as `0`, `1`, `2`, `8`, `20`, `40`, `80`, and `120`
columns with:

- CJK text.
- Emoji and combining characters.
- ANSI styling.
- Long unbroken path, URL, and hash.
- Markdown list and code block.
- Empty and oversized values.
- Embedded CR/LF passed to a single-row helper.
- `wrapTextWithAnsi` with a two-cell grapheme at width `1`.

Assert every final line fits its visible width. Assert collapsed limits in rendered rows
after wrapping. At width `1`, an indivisible two-cell grapheme may be omitted but must not
be split or overflow.

### Real-surface check

Run Pi in a controlled terminal session:

1. Invoke the tool in a scenario that produces useful detail.
2. Capture collapsed output with `tmux capture-pane`.
3. Trigger the configured `app.tools.expand` action.
4. Capture expanded output.
5. Verify hierarchy, content, status transition, width, and key hint.
6. Repeat once for failure or truncation.
7. Tear down the terminal session and any spawned process or temporary resource.

Tests prove behavior; the TUI capture proves integration and visual usability.

---

## Review checklist

Before shipping a renderer, confirm:

- [ ] Call header identifies operation and target without exposing noisy arguments.
- [ ] Partial output shows meaningful current activity.
- [ ] Collapsed result answers state, outcome, and next action within its rendered-row budget.
- [ ] Expanded result prioritizes result, activity, or error according to state.
- [ ] Status text does not rely on color or icon alone.
- [ ] Zero and unavailable metadata are omitted.
- [ ] Truncation is explicit and recoverable.
- [ ] Empty output is explicit.
- [ ] Malformed details fall back to raw content.
- [ ] Every line is width-safe with Unicode and ANSI styling.
- [ ] Configured expand key hint is used.
- [ ] Model-facing content, errors, side effects, and persistence are unchanged.
- [ ] Interactive components clamp scroll state and expose active navigation bindings.
- [ ] Timers, subscriptions, listeners, widgets, and scheduled renders are cleaned up.
- [ ] Component tests and real TUI capture both pass.

---

## Pattern provenance and references

| Source | Pattern worth borrowing |
|---|---|
| Pi render APIs and examples | Separate call/result slots, partial state, configured expansion, structured details, explicit truncation artifacts |
| OpenAI Codex TUI | Apply limits after wrapping; preserve head and tail; report omitted-line count and empty output |
| Goose | Concise/detailed disclosure and user-controlled verbosity |
| OpenCode | Group repeated low-information context tools and summarize them with counts |
| Vercel AI Elements | Separate header, lifecycle state, input, output, and error presentation |
| VS Code chat tools | Compact tool summary with a separate route to terminal/output detail |
| Carbon and WCAG | Pair status text with symbol and restrained color; never rely on color alone |
| CLI Guidelines and Nielsen Norman Group | Say enough to prove progress, keep defaults quiet, and make errors actionable |

References:

- [Pi extension tool rendering](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi TUI components](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)
- [Pi built-in tool renderer example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/built-in-tool-renderer.ts)
- [Pi truncated-tool example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/truncated-tool.ts)
- [OpenAI Codex TUI command renderer](https://github.com/openai/codex/blob/9a8730f3/codex-rs/tui/src/exec_cell/render.rs)
- [Goose tool-output verbosity](https://goose-docs.ai/docs/guides/managing-tools/)
- [OpenCode tool renderer](https://github.com/anomalyco/opencode/blob/9afbdc10/packages/ui/src/components/message-part.tsx)
- [Vercel AI Elements Tool](https://elements.ai-sdk.dev/components/tool)
- [Gemini CLI configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)
- [VS Code chat tools](https://code.visualstudio.com/docs/chat/chat-tools)
- [Carbon status indicators](https://carbondesignsystem.com/patterns/status-indicator-pattern/)
- [WCAG: Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)
- [Command Line Interface Guidelines](https://clig.dev/)
- [Nielsen Norman Group: Progress Indicators](https://www.nngroup.com/articles/progress-indicators/)
