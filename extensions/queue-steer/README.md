# queue-steer

Visible steering and follow-up timeline for Pi. Steering rows stay in a blue next-turn lane, follow-ups stay in a yellow after-this-run lane, and row edits keep Pi’s native editor behavior intact.

## Upstream
- Source: https://github.com/tmustier/pi-queue-steer
- Version: 0.1.0
- Inspected commit: 50e7db60d7f9f2b9a8c9a42e9e151a976137f13b (post-v0.1.0 main)
- License: MIT © Thomas Mustier
- Local adaptation: structured `src/` layout with root `index.ts` shim, `.js` import specifiers, Pi 0.79-compatible trust detection and `agent_settled` registration typing, Vitest test rewrites, and local docs.

## Controls
- Uses configured Pi action bindings for dequeue, follow-up, submit, and interrupt.
- `Option+Up` selects the most recently queued row, then moves through the visible timeline.
- `Option+Down` moves to the next visible row.
- Empty `Enter` promotes the oldest follow-up while busy, or resumes after a pause.
- `Escape` cancels the current edit or pauses active delivery.

## Hooks
- `session_start` installs the queue widget and editor wrapper.
- `agent_start` recomposes after late editor chrome and reloads settings.
- `input` captures queued steering/follow-up messages and edit submits.
- `turn_end` and `agent_end` deliver queued rows at Pi boundaries.
- `agent_settled` refreshes the timeline and drains idle queue state.
- `session_shutdown` clears widget, timers, drafts, and queue state.

## Settings
- Reads `.pi/settings.json` only for trusted projects.
- `steeringMode` and `followUpMode` accept `one-at-a-time` or `all`.
- Queue state, pause state, and edit drafts stay local to the running Pi session.