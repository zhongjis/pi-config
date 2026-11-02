# T3 Code–Native Subagent Presentation

Status: planned

## Problem Statement

When I run Panda Harness through T3 Code (Pi provider), my Subagent work looks foreign. Every Subagent launch is a generic `agent` tool row whose live output reads only "12 tool uses...". T3 Code has a native subagent card (title, model, live progress, result, bot icon, background-work banner), but our Subagents never appear in it: T3 Code recognizes only Pi tool events named `subagent` whose details carry `results[]` in the shape of Pi's example subagent extension. `/agents`, `/agent-monitor`, and `/agent-graph-replay` appear in T3 Code's command list but silently do nothing, because they rely on terminal-only components that Pi's RPC mode does not support. T3 Code's Stop button stops the orchestrator's turn, but background Subagents and agent graph runs keep going, because stopping them takes a second Esc, a terminal key that does not exist in RPC mode. The two hosts therefore disagree about what "stop" means. The terminal experience is good; the T3 Code experience is second-class, and I cannot change T3 Code or Pi.

## Solution

Make the Subagents extension speak T3 Code's existing, unmodified Pi integration contract, outside the terminal only, while leaving the terminal experience, the model-facing tool surface, and every Subagent capability intact:

- Keep the model-facing `agent` tool unchanged. Add an internal, never-declared `subagent` **presentation tool**. Outside the terminal, the `agent` tool (fresh and resumed foreground runs) and waiting `get_agent_result` run it as a nested tool call via `ctx.executeTool`; it streams the Execution's state as `details.results`, so T3 Code renders a native subagent card with live progress and final result.
- Make streamed (partial) tool content a human-readable progress line outside the terminal, so generic rows are informative too. Final model-facing content stays unchanged.
- Register `/agents`, `/agent-monitor`, and `/agent-graph-replay` only in terminal sessions, so T3 Code never lists commands that cannot work there. Interactive inspection stays a terminal capability for now.
- Make one stop signal end all orchestrator-owned work in every host: the terminal's Esc and T3 Code's Stop both abort the orchestrator run, and that abort stops its foreground Subagents, background Subagents, and agent graph runs. The terminal's second-Esc stop is removed.

## User Stories

1. As a T3 Code user, I want each foreground Subagent run to appear as a native subagent card, so that delegated work looks like first-class T3 Code work.
2. As a T3 Code user, I want the card title to show the Subagent's display name, so that I can tell which specialist is working.
3. As a T3 Code user, I want the card prompt to show the bounded task description, so that I know what was delegated.
4. As a T3 Code user, I want the card to show the model actually used, so that I can judge cost and capability.
5. As a T3 Code user, I want the card to show the current activity first while running, so that the 200-character progress preview is useful.
6. As a T3 Code user, I want the card to switch to completed and show the final result, so that I can read the outcome in place.
7. As a T3 Code user, I want failed runs (including thrown errors and resume failures) to show as failed with the error, so that failures are never mistaken for success or left running.
8. As a T3 Code user, I want stopped or aborted runs to show as interrupted with a reason, so that cancellation is distinguishable from failure.
9. As a T3 Code user, I want a card never to stay "running" after its tool call ends, so that the thread is not held open by a phantom background task.
10. As a T3 Code user, I want a foreground run converted to background at the check-in to end its card truthfully ("continues in background as <id>"), so that the timeline never lies.
11. As a T3 Code user, I want `get_agent_result` with `wait: true` to show a native card with live progress and then the real result, so that background runs also become first-class when awaited.
12. As a T3 Code user, I want a waiting retrieval that returns at the check-in to end its card truthfully, so that check-ins do not leave stuck cards.
13. As a T3 Code user, I want parallel Subagent launches to produce one card each, so that I can follow each specialist.
14. As a T3 Code user, I want resumed runs to render the same card as fresh runs, so that resume does not look different.
15. As a T3 Code user, I want delegation-policy denials to show as failed rows with the denial reason, so that I understand why nothing started.
16. As a T3 Code user, I want generic Subagent tool rows (background launch, retrieval without wait, steering) to show readable text, so that nothing reads as a bare counter.
17. As a T3 Code user, I want `/agents`, `/agent-monitor`, and `/agent-graph-replay` absent from the command list, so that I never pick a command that silently does nothing.
18. As a terminal user, I want those commands to keep working exactly as before, so that terminal inspection, steering, stopping, settings, and replay are unchanged.
19. As a user in either host, I want one stop (Esc or Stop) to end the orchestrator's foreground and running or queued background Subagents, so that no delegated work outlives my stop.
20. As a user in either host, I want the same stop to end the orchestrator's running agent graph runs, so that one rule covers all delegated work.
21. As a user, I want a notification naming what the stop ended, so that I know background work was stopped.
22. As a user, I want graph-owned and nested Subagents to stop with their owner rather than individually, so that stop semantics stay hierarchical.
23. As a terminal user, I want no "Press Esc again to stop" hint and no second-Esc window, so that stopping is one action and Pi's own double-Esc is never intercepted.
24. As a T3 Code user, I want a visible signal when a background Subagent completes, so that I know why the orchestrator woke up.
25. As a T3 Code user, I want card updates throttled, so that the T3 Code event stream is not flooded by spinner ticks.
26. As a T3 Code user in Supervised mode, I want at most one approval for the presentation tool per session, so that cards do not cost repeated prompts.
27. As a terminal user, I want tool rows, fleet widget, status line, viewers, menus, and history to look and behave exactly as before, so that the T3 Code work costs me nothing; the only intended terminal behavior change is the unified stop.
28. As an orchestrator model, I want the `agent`, `get_agent_result`, and `steer_subagent` tools, their parameters, results, and prompts unchanged, so that delegation behavior is unaffected.
29. As an orchestrator model, I never want to see the presentation tool declared, so that my tool list does not change.
30. As a Subagent, I want the presentation tool excluded from my tools like the other orchestration tools, so that I cannot reach it.
31. As a maintainer, I want the card projection derived from the same runtime record as the existing presentation details, so that card and terminal row never disagree.
32. As a maintainer, I want one wrapper to guarantee a terminal card entry on every exit path, so that "stuck running" cannot be reintroduced branch by branch.
33. As a maintainer, I want terminal-only behavior gated on Pi's documented `ctx.mode`, so that host detection is not guesswork.
34. As a maintainer, I want no `agent_graph` behavior changed, so that scope stays bounded.

## Implementation Decisions

- **No rename.** The model-facing `agent` tool keeps its name, schema, description, results, and prompts. Rejected: global rename (≈140 prompt/doc mentions with no test coverage by repository rule; breaks terminal renderer lookup for old `agent` history rows; still yields no cards for waits); host-conditional rename (shared session files disagree across hosts); dual registration (model-visible duplication).
- **Presentation tool.** A new extension-registered tool named `subagent`, `exposure: "deferred"` (callable via `ctx.executeTool`, never declared to the model), constant empty arguments, added to the extension's tool-name constant so Subagent exclusion covers it. Its `execute` looks up a live presentation channel registered by the calling tool for its nested call id (`<parent id>/<n>`); with no live channel it returns an error immediately. While attached it forwards each projected state through `onUpdate` and resolves with the final projected state.
- **Who presents.** Only when `ctx.mode !== "tui"` and UI exists: foreground `agent` (fresh and resume) and `get_agent_result` with `wait: true` for an independent agent (not `agr_*` graph runs). The caller starts the nested call without awaiting it, so the real run never waits on presentation, and settles it in a `finally` before returning. Background and queued launches present no card (a finished launch call cannot stay truthfully running in unmodified T3 Code).
- **Closing invariant.** One wrapper around presenting executions guarantees: once a running entry was streamed, the nested call resolves with a finished entry on every exit — normal result, policy denial, resume failure, thrown error, abort, foreground-to-background conversion, check-in return. Unknown or thrown endings become failed with the error message.
- **Projection (pure function of record + snapshot) → one `results` entry in the example-extension shape:**
  - `agent` = display name; `task` = description; `step` = 0; `model` = actual session `provider/id` when known.
  - Running: `finished: false`; one assistant message: current activity first, then latest response tail.
  - Completed / force-steered completion: `finished: true`, `exitCode: 0`, final result text.
  - Converted to background or check-in return: `finished: true`, `exitCode: 0`, text "continues in background as <id>" (least-wrong terminal state: "interrupted" would read as lost work; "running" would hold T3 thread completion).
  - Error / denial / thrown: `finished: true`, `exitCode: 1`, `stopReason: "error"`, `errorMessage`.
  - Stopped / aborted (including `signal.aborted`): `finished: true`, `stopReason: "aborted"`, `errorMessage` with the reason, plus an assistant message.
  - Text capped at 10,000 characters (T3's limit); full text stays in existing details and results.
- **Throttling.** Outside the terminal: no spinner ticks; presentation and partial-content updates emit only on activity change, at most about once per second.
- **Readable partial content.** Outside the terminal, partial `content` of `agent` and waiting `get_agent_result` is a short progress line (display name · model · elapsed · tool uses · activity). Terminal partial updates are unchanged (waiting retrieval streams only outside the terminal, so its terminal renderer is untouched). Final `content` and `isError` are unchanged.
- **Terminal-only commands.** `/agents`, `/agent-monitor`, and `/agent-graph-replay` register through the shared library's terminal-only command registration (the same mechanism other Extensions use), so RPC `get_commands` never lists them. Their menus, viewers, settings, and graph dialogs stay unchanged and get no RPC fallback. This is the only `agent_graph`-adjacent change: registration of its replay command.
- **Unified stop (all hosts).** The terminal's Esc and T3 Code's Stop (Pi RPC `abort`, sent after clearing the queue) both reach the extension as an aborted `agent_settled`. Foreground Subagents already stop through their tool abort signal. On an aborted settle, the background-stop module immediately stops orchestrator-owned running or queued background agents (user-stop provenance) and running local agent graph runs; graph-owned and nested children stop with their owner. It then notifies once what it stopped. The second-Esc window, its terminal-input listener, its idle check, and the "Press Esc again" hint are removed, so Pi's own double-Esc is never intercepted. Accepted costs: interrupting the orchestrator no longer keeps its workers running (typing while it runs still steers or queues a follow-up without aborting); a single Esc ends running graph runs, and a stopped graph run cannot resume; stopped Subagents remain resumable. Rejected: a confirm dialog after every stop (an extra blocking prompt, and unverified dialog delivery after the turn ends in T3 Code); keeping graph runs alive (T3 Code would have no way to stop them, since `/agent-monitor` is terminal-only).
- **Fleet widget and status line:** unchanged.
- **Background completion signal.** Outside the terminal, when a background completion wake turn starts, also emit one `ui.notify` line naming the finished agent(s) (T3 Code ignores custom messages and shows notify only during an active turn).
- **Incompatibility.** Pi's example `subagent` extension cannot be loaded alongside (tool-name collision); documented, not guarded.

## Testing Decisions

- Test external behavior at the highest existing seam: a registered tool's `execute` with captured `onUpdate`, a fake `ctx` exposing `mode`, `hasUI`, `ui`, and `executeTool`, and the returned `{content, details, isError}`. No tests on literal prompt wording.
- Seam 1 (presentation): with `mode: "rpc"`, assert the nested `subagent` call receives running then finished entries for completed, failed, thrown, resume-failed, policy-denied, aborted, converted, and check-in outcomes; that background/queued launches and graph retrievals start none; that `mode: "tui"` starts none; that `agent` final content/details are unchanged. Prior art: foreground result retrieval, execution entry points, agent-tool errors, policy-denial result, evicted resume tests.
- Seam 2 (presentation tool): direct `execute` without a live channel errors; Subagent sessions do not receive it (existing nested-tool-scope tests).
- Seam 3 (terminal-only commands): extend the existing real-RPC terminal-only commands integration test with the subagents Extension and `agents`, `agent-monitor`, `agent-graph-replay`, asserting presence in TUI sessions and absence from RPC `get_commands`.
- Seam 4 (stop): rewrite the background-stop tests for the new contract: in both `tui` and non-terminal modes, an aborted settle stops orchestrator-owned running/queued agents and running graph runs, skips graph-owned and nested children, notifies once, and installs no terminal-input listener; a non-aborted settle stops nothing.
- Terminal QA in `interactive_shell`: one Esc during a turn with running background agents and a graph run stops all of them; a second Esc is left to Pi.
- Integration: existing terminal subagent rendering integration test passes unchanged.
- Manual QA in T3 Code with a real Pi session, Supervised and Full access: foreground, failure, stop, parallel, resume, background + wait, conversion, Stop with running background agents, the three commands absent from the T3 Code command menu, background completion notify. Check whether the nested call also shows a generic row and how many approvals Supervised asks.

## Out of Scope

- Any change to T3 Code or Pi.
- `agent_graph`, graph menus, dialogs, and presentation (except registering `/agent-graph-replay` terminal-only, and the unified stop ending running graph runs).
- `/agents`, `/agent-monitor`, conversation viewing, interactive steering, settings, and replay in T3 Code; they remain terminal-only for now.
- Stopping the orchestrator's turn while keeping its background work running, in either host.
- Native cards for background launches, non-waiting retrieval, or steering.
- "Open subagent" child-thread links (T3 Code provides them only for `delegate_task` children).
- Routing Subagents through T3 Code's `delegate_task`.
- Renaming any model-facing tool.

## Further Notes

- Evidence: T3 Code's Pi adapter handles nested tool events (`parentToolCallId`) and recognizes `toolName === "subagent"` with `details.results[]` regardless of parent; card id is the tool call id plus `step`; status turns terminal when the tool call ends; a running subagent item counts as pending background work that holds thread completion. Generic rows show partial `content` and ignore `details`. Pi 1.4 documents `ctx.executeTool`, nested event ids `<parent>/<n>`, `deferred` exposure, `custom()` returning `undefined` in RPC mode, and `ctx.mode` as the guard.
- T3 Code's Stop normally sends RPC `abort`; for permission-mode changes, manual compaction, or a runtime restart it terminates the Pi process instead, which ends every in-process Subagent regardless of this spec.
- To verify in QA: T3 Code's Supervised hook may ask approval for the nested call (constant args allow "accept for session"); mode tool rules apply to nested calls (`+@all` expected to cover the deferred tool); whether the nested call adds a generic row next to the card; whether the stop notification appears in the work log after the turn settles (T3 Code shows notify only during an active turn); whether an Esc during a retry backoff or compaction also settles as aborted and therefore stops background work.
