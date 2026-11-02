# T3 Code–Native Subagent Presentation

Status: planned

## Problem Statement

When I run Panda Harness through T3 Code (Pi provider), my Subagent work should look like first-class T3 Code work. T3 Code has a native subagent card (title, model, live progress, result, bot icon, background-work banner), but it recognizes only Pi tool events named `subagent` whose details carry `results[]` in the shape of Pi's example subagent extension; any other tool renders as a generic row. A presentation side channel that keeps a differently named delegation tool produces a card but repeats each run as an extra generic row and an extra Supervised approval. `/agents`, `/agent-monitor`, and `/agent-graph-replay` cannot work in T3 Code because they rely on terminal-only components that Pi's RPC mode does not support. T3 Code's Stop must end delegated work the same way the terminal's Esc does. I cannot change T3 Code or Pi.

## Solution

Make the Subagents extension speak T3 Code's existing, unmodified Pi integration contract while keeping every Subagent capability:

- The model-facing delegation tool is named `subagent`. Outside the terminal, foreground `subagent` runs (fresh and resumed) stream the Execution's state as `details.results`, so T3 Code renders one native card per run next to the tool's own row.
- Streamed (partial) tool content is a human-readable progress line outside the terminal, for the `subagent` tool and for waiting `get_agent_result`. Final model-facing content is unchanged.
- Older sessions that recorded the delegation tool under its earlier name still render in the terminal.
- `/agents`, `/agent-monitor`, and `/agent-graph-replay` register only in terminal sessions.
- One stop signal ends all orchestrator-owned work in every host: the terminal's Esc and T3 Code's Stop both abort the orchestrator run, and that abort stops its foreground Subagents, background Subagents, and agent graph runs.
- Stopped runs report their real cause in readable text, including after a Pi restart.

## User Stories

1. As a T3 Code user, I want each foreground Subagent run to appear as a native subagent card, so that delegated work looks like first-class T3 Code work.
2. As a T3 Code user, I want each run to appear as one tool row plus one card, so that the timeline does not repeat the same run.
3. As a T3 Code user, I want the card title to show the Subagent's display name, so that I can tell which specialist is working.
4. As a T3 Code user, I want the card prompt to show the bounded task description, so that I know what was delegated.
5. As a T3 Code user, I want the card to show the model actually used, so that I can judge cost and capability.
6. As a T3 Code user, I want the card to show the current activity first while running, so that the 200-character progress preview is useful.
7. As a T3 Code user, I want the card to switch to completed and show the final result, so that I can read the outcome in place.
8. As a T3 Code user, I want failed runs (including thrown errors and resume failures) to show as failed with the error, so that failures are never mistaken for success or left running.
9. As a T3 Code user, I want stopped runs to show as interrupted with a readable reason such as a user stop, so that cancellation is distinguishable from failure and never reads as a raw exception.
10. As a T3 Code user, I want a card never to stay "running" after its tool call ends, so that the thread is not held open by a phantom background task.
11. As a T3 Code user, I want a foreground run converted to background at the check-in to end its card truthfully ("continues in background as <id>"), so that the timeline never lies.
12. As a T3 Code user, I want `get_agent_result` with `wait: true` to show live readable progress in its row, so that waiting is not a silent spinner.
13. As a T3 Code user, I want parallel Subagent launches to produce one card each, so that I can follow each specialist.
14. As a T3 Code user, I want resumed runs to render the same card as fresh runs, so that resume does not look different.
15. As a T3 Code user, I want delegation-policy denials to show as failed with the denial reason, so that I understand why nothing started.
16. As a T3 Code user, I want generic Subagent tool rows (background launch, retrieval, steering) to show readable text, so that nothing reads as a bare counter.
17. As a T3 Code user in Supervised mode, I want one approval per Subagent call, so that cards cost no extra prompts.
18. As a T3 Code user, I want `/agents`, `/agent-monitor`, and `/agent-graph-replay` absent from the command list, so that I never pick a command that silently does nothing.
19. As a terminal user, I want those commands to keep working exactly as before, so that terminal inspection, steering, stopping, settings, and replay are unchanged.
20. As a user in either host, I want one stop (Esc or Stop) to end the orchestrator's foreground and running or queued background Subagents, so that no delegated work outlives my stop.
21. As a user in either host, I want the same stop to end the orchestrator's running agent graph runs, so that one rule covers all delegated work.
22. As a user, I want a notification naming what the stop ended, so that I know background work was stopped.
23. As a user, I want graph-owned and nested Subagents to stop with their owner rather than individually, so that stop semantics stay hierarchical.
24. As a terminal user, I want stopping to be one action with no second-Esc window, so that Pi's own double-Esc is never intercepted.
25. As a T3 Code user, I want a visible signal when a background Subagent completes, so that I know why the orchestrator woke up.
26. As a T3 Code user, I want card updates throttled, so that the T3 Code event stream is not flooded by spinner ticks.
27. As a user, I want a stopped Subagent's cause preserved across a Pi restart, so that retrieval reports why it stopped instead of "cause unknown".
28. As a terminal user, I want tool rows, fleet widget, status line, viewers, menus, and history to look and behave as before, so that the T3 Code work costs me nothing.
29. As a terminal user, I want sessions recorded with the earlier delegation tool name to keep their rich rows, so that history stays readable.
30. As an orchestrator model, I want every prompt, tool description, delegation hint, and roster to name the `subagent` tool, so that I never call a tool that does not exist.
31. As an orchestrator model, I want the tool's parameters, results, and the `get_agent_result` and `steer_subagent` tools unchanged, so that delegation behavior is unaffected.
32. As a Subagent, I want the delegation tool excluded from my tools like the other orchestration tools, so that I cannot recursively delegate.
33. As a maintainer, I want the card projection derived from the same runtime record as the terminal presentation details, so that card and terminal row never disagree.
34. As a maintainer, I want one wrapper to guarantee a terminal card entry on every exit path, so that "stuck running" cannot be reintroduced branch by branch.
35. As a maintainer, I want terminal-only behavior gated on Pi's documented `ctx.mode`, so that host detection is not guesswork.

## Implementation Decisions

- **Tool name.** The model-facing delegation tool is `subagent`, sourced from the extension's tool-name constant; every consumer (Subagent tool exclusion, nested orchestration tool list, delegation-policy denial hook, profiles hook, usage reporting, prompts, skills, docs) uses that name. Its schema and behavior are unchanged. `get_agent_result`, `steer_subagent`, `delegate_research`, `agent_graph`, and `resolve_agent_graph_gate` keep their names; the agent-graph node type `"agent"` is a different identifier and is unchanged.
- **History rendering.** A tool renderer resolver maps the earlier tool name `agent` to the `subagent` renderers when no registered tool claims it, so older sessions keep their terminal rows. No tool is registered under that name.
- **Who presents.** Only when `ctx.mode !== "tui"` and UI exists, and only for foreground `subagent` runs (fresh and resumed). Background and queued launches carry no `results` (T3 Code would mark a finished launch call's card completed). `get_agent_result` presents no card; T3 Code builds cards only from tool events named `subagent`.
- **Closing invariant.** T3 Code treats an entry with `finished: true` in a partial update as terminal and ignores an end event without `results`. One wrapper therefore emits a final partial update carrying the finished entry on every exit after something was streamed — normal result, policy denial, resume failure, thrown error, abort, foreground-to-background conversion — without changing what the call returns or throws. The final result's details also carry the finished entry.
- **Projection (pure function of record + snapshot) → one `results` entry in the example-extension shape:**
  - `agent` = display name; `task` = description; `step` = 0; `model` = actual session `provider/id` when known.
  - Running: `finished: false`; one assistant message: current activity first, then latest response tail.
  - Completed / force-steered completion: `finished: true`, `exitCode: 0`, final result text.
  - Converted to background: `finished: true`, `exitCode: 0`, text "continues in background as <id>" (least-wrong terminal state: "interrupted" would read as lost work; "running" would hold T3 thread completion).
  - Error / denial / thrown: `finished: true`, `exitCode: 1`, `stopReason: "error"`, `errorMessage`.
  - Stopped / aborted: `finished: true`, `stopReason: "aborted"`, `errorMessage` and assistant text derived from the record's interruption cause (for example a user stop), never a raw exception string.
  - Text capped at 10,000 characters (T3's limit); full text stays in existing details and results.
- **Throttling.** Outside the terminal: no spinner ticks; presentation and partial-content updates emit only on activity change, at most about once per second.
- **Readable partial content.** Outside the terminal with UI, partial `content` of `subagent` and waiting `get_agent_result` is a short progress line (display name · model · elapsed · tool uses · activity), followed by a short tail of the latest response. Terminal partial updates are unchanged. Final `content` and `isError` are unchanged.
- **Interruption cause persistence.** Independent-agent history records the interruption cause, so a record restored after a Pi restart reports its real cause; entries without it still load.
- **Terminal-only commands.** `/agents`, `/agent-monitor`, and `/agent-graph-replay` register through the shared library's terminal-only command registration, so RPC `get_commands` never lists them. Their menus, viewers, settings, and graph dialogs get no RPC fallback.
- **Unified stop (all hosts).** The terminal's Esc and T3 Code's Stop (Pi RPC `abort`, sent after clearing the queue) both reach the extension as an aborted `agent_settled`. Foreground Subagents stop through their tool abort signal. On an aborted settle, the background-stop module stops orchestrator-owned running or queued background agents (user-stop provenance) and running local agent graph runs; graph-owned and nested children stop with their owner. It then notifies once what it stopped. The module installs no terminal-input listener. Accepted costs: interrupting the orchestrator also ends its workers (typing while it runs still steers or queues a follow-up without aborting); a single Esc ends running graph runs, and a stopped graph run cannot resume; stopped Subagents remain resumable. Rejected: a confirm dialog after every stop; keeping graph runs alive (T3 Code would have no way to stop them).
- **Background completion signal.** Outside the terminal with UI, when a Subagent follow-up message enters its turn (`message_start`, inside the wake turn), emit one `ui.notify` line naming the reported Subagents and their status (T3 Code ignores custom messages and shows notify only during an active turn).
- **Fleet widget and status line:** unchanged.
- **Incompatibility.** Pi's example `subagent` extension cannot be loaded alongside (tool-name collision); documented, not guarded.
- **Rejected designs.** A hidden nested `subagent` presentation tool beside a differently named delegation tool: it produced cards (including for waits) but repeated every run as an extra generic row and an extra Supervised approval. Keeping wait cards by letting the delegation tool double as a nested presenter: it brings the repeated row and the extra approval back for waits.

## Testing Decisions

- Test external behavior at the highest existing seam: the registered `subagent` tool's `execute` with captured `onUpdate`, a fake `ctx` exposing `mode`, `hasUI`, and `ui`, and the returned `{content, details, isError}`. No tests on literal prompt wording.
- Seam 1 (presentation): with `mode: "rpc"`, assert streamed running entries and a final finished entry for completed, failed, thrown, resume-failed, policy-denied, aborted, and converted outcomes; that background/queued launches and `mode: "tui"` carry no `results`; that final content is unchanged; that aborted text is readable.
- Seam 2 (names): Subagent sessions do not receive the `subagent` tool; delegation-policy denial, profiles, and usage hooks act on `subagent`; the history renderer resolver renders `agent` rows.
- Seam 3 (terminal-only commands): the real-RPC terminal-only commands integration test asserts presence in TUI sessions and absence from RPC `get_commands`.
- Seam 4 (stop): background-stop tests assert an aborted settle stops orchestrator-owned running/queued agents and running graph runs, skips graph-owned and nested children, and notifies once.
- Seam 5 (history): a restored stopped record keeps its interruption cause.
- Manual QA in T3 Code with a real Pi session: foreground, parallel, background + wait, background wake notify, Stop with running background agents, Supervised approval count, the three commands absent from the command menu.

## Out of Scope

- Any change to T3 Code or Pi.
- `agent_graph`, graph menus, dialogs, and presentation (except registering `/agent-graph-replay` terminal-only, and the unified stop ending running graph runs).
- `/agents`, `/agent-monitor`, conversation viewing, interactive steering, settings, and replay in T3 Code; they remain terminal-only for now.
- Stopping the orchestrator's turn while keeping its background work running, in either host.
- Native cards for background launches, retrieval, or steering.
- "Open subagent" child-thread links (T3 Code provides them only for `delegate_task` children).
- Routing Subagents through T3 Code's `delegate_task`.

## Further Notes

- Evidence: T3 Code's Pi adapter recognizes `toolName === "subagent"` with `details.results[]`; card id is the tool call id plus `step`; status turns terminal when the tool call ends or an entry reports `finished: true`; a running subagent item counts as pending background work that holds thread completion. Every `subagent` call also renders T3 Code's generic tool row. Generic rows show partial `content` and ignore `details`. Pi 1.4 documents `custom()` returning `undefined` in RPC mode, `ctx.mode` as the guard, and tool renderer resolvers for unregistered tool names.
- T3 Code's Stop normally sends RPC `abort`; for permission-mode changes, manual compaction, or a runtime restart it terminates the Pi process instead, which ends every in-process Subagent regardless of this spec.
- To verify in QA: whether an Esc during a retry backoff or compaction also settles as aborted and therefore stops background work.
