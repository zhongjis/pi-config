# Herdr side panel for live subagent output

Status: idea

## Summary

A Herdr pane can show a subagent transcript on the right without competing with Pi's TUI renderer. It cannot attach directly to the current subagent, because `extensions/subagent/` runs each child as an in-process `AgentSession`, not as a process in its own PTY. The extension therefore needs a small read-only bridge between `AgentRun` or `AgentSession` events and a viewer process running in the Herdr pane.

This is feasible. It should remain optional, require an active Herdr environment, and leave `AgentRun` as the source of truth.

## Current behavior

`/agents` selects a running record, then `viewAgentConversation()` opens `ConversationViewer` as a centered Pi overlay at 90% width. `ConversationViewer` subscribes to the child `AgentSession` and requests a Pi TUI render for each session update. It shows live assistant text and tool names, but truncates tool and shell results to 500 characters.

The main agent and viewer share one TUI render loop. Moving this viewer to a Pi `right-center` overlay would improve layout, but it would still repaint inside the same terminal surface. It may reduce disruption; it does not isolate the viewer from the flicker reported while the main agent streams.

Relevant code:

- `extensions/subagent/src/ui-wiring/commands.ts` — `/agents` and `viewAgentConversation()`
- `extensions/subagent/src/ui/conversation-viewer.ts` — live transcript rendering
- `extensions/subagent/src/agent-runner.ts` — `onTextDelta`, tool, turn, and session callbacks
- `extensions/subagent/src/agent-run.ts` — ordered per-run event stream and state
- `extensions/subagent/src/output-file.ts` — per-agent JSONL transcript file

## Why Herdr needs a bridge

Herdr can split the current pane, run a command in the new pane, and observe terminal-backed agents. Its attach APIs target Herdr terminals or agents that already own a PTY. A Pi subagent has no independent PTY for Herdr to attach to.

The existing `.output` file is useful but insufficient for token-level viewing. `streamToOutputFile()` flushes new messages on `turn_end`; `tail -f` would update after each completed turn, not while assistant text is arriving.

True live viewing needs a private display feed. The extension can derive it from existing callbacks without changing the frozen `subagents:*` event contract:

- assistant text deltas from `onTextDelta`
- tool start/end from `onToolActivity`
- turn boundaries from `onTurnEnd`
- terminal status from `AgentRun`

## Proposed flow

1. Add an explicit action such as **Open in Herdr** for one selected running agent.
2. Guard it with `HERDR_ENV=1` and Herdr availability. Otherwise offer the existing Pi viewer.
3. Split the calling pane without stealing focus:

   ```bash
   herdr pane split --current --direction right --ratio 0.35 --no-focus
   ```

4. Read the returned pane ID. Label it, then run a small transcript viewer there with `herdr pane run <pane-id> <command>`.
5. Feed the viewer private NDJSON events from the selected run. Write text as deltas rather than repeated `fullText`; coalesce repaint notifications to avoid excessive writes.
6. Close only panes created by this feature. Clean up the feed and subscriptions on viewer exit, agent expiry, session switch, reload, and shutdown.

The first prototype may parse the existing `.output` JSONL to validate pane creation and transcript formatting. It must be described as turn-level output. Token-level streaming should wait for the private delta bridge.

## Pi-native fallback

Pi already supports a responsive side overlay:

```ts
{
  overlay: true,
  overlayOptions: {
    anchor: "right-center",
    width: "40%",
    minWidth: 40,
    nonCapturing: true,
    visible: (width) => width >= 100,
  },
}
```

This is the smallest change and can reuse `ConversationViewer`. It is an overlay, not a real split, and shares Pi's TUI renderer. Use it when Herdr is unavailable or when repaint isolation is not required.

## Constraints

- Keep `AgentRun` authoritative. Herdr displays state; it does not own lifecycle, completion, stop, resume, or notification state.
- Do not add or change shared `subagents:*` payloads for a display-only integration.
- Do not shell-interpolate agent prompts, descriptions, or paths. Invoke Herdr with argument arrays and pass viewer input through a file descriptor, socket, or safely encoded path.
- Default to one selected-agent viewer pane. A multi-agent dashboard is separate scope.
- Keep steering, stopping, and prompt input out of the first version. Read-only viewing proves the integration with lower risk.
- Herdr panes persist independently. Record ownership so cleanup never closes a pane the user created.

## Prototype acceptance checks

- Opening a running agent creates one right-side Herdr pane and keeps focus in Pi.
- Assistant text appears in that pane during generation, before `turn_end`.
- Tool start/end entries appear once and in order.
- Main Pi streaming continues without viewer-triggered full-screen flicker.
- Closing the viewer does not stop the subagent.
- Agent completion leaves a final readable transcript and terminal status.
- Missing Herdr or `HERDR_ENV != 1` produces no pane and falls back cleanly.
- Session switch, reload, and shutdown remove subscriptions and close only owned panes.

## Recommendation

Prototype the Herdr path, because a separate pane isolates rendering and directly addresses the reported flicker. Start with the existing turn-level `.output` file to prove topology. If the UX is useful, add the private delta bridge for true streaming. Keep the Pi `right-center` overlay as the no-Herdr fallback.

## Sources

Pi docs read from the local upstream mirror:

- `.pi/skills/pi-docs-playbook/source/packages/coding-agent/docs/tui.md`
- `.pi/skills/pi-docs-playbook/source/packages/coding-agent/docs/extensions.md`
- `.pi/skills/pi-docs-playbook/source/packages/coding-agent/docs/keybindings.md`
- `.pi/skills/pi-docs-playbook/source/packages/tui/README.md`

External:

1. [Herdr repository](https://github.com/ogulcancelik/herdr)
2. [Herdr CLI reference](https://herdr.dev/docs/cli-reference/)
3. [Herdr socket API](https://herdr.dev/docs/socket-api/)
4. [Herdr agent model](https://herdr.dev/docs/agents/)
