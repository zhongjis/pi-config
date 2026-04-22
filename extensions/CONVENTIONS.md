# Extension Conventions

## Custom `pi.events` standard

Use `pi.events` for cross-extension coordination only. In this repo, custom channels fall into 3 classes:

- **Shared semantic signal** — stable repo-wide meaning. Current shared signal: `user-prompted`.
- **Lifecycle / discovery broadcast** — one-way status events named `<namespace>:<event>`, e.g. `subagents:created`, `subagents:started`, `subagents:completed`, `subagents:failed`, `subagents:ready`, `subagents:steered`.
- **RPC request / reply** — request on `<namespace>:rpc:<method>`, reply on `${channel}:reply:${requestId}`.

### Naming + contract rules

- Keep existing shared signal `user-prompted` as-is. Do **not** rename it to a namespaced form now.
- New lifecycle/discovery families should use colon namespaces.
- Every RPC request payload must include `requestId`.
- Every RPC reply must use envelope `{ success: true, data? } | { success: false, error: string }`.
- Temporary reply listeners must always unsubscribe on settle, timeout, or abort.

## Event Bus: `user-prompted`

Any **LLM-callable tool** (`registerTool`) that blocks on user input must emit
`pi.events.emit("user-prompted", { tool: "<name>" })` **once per tool execution, before the first blocking UI prompt**.

```typescript
export default function myTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_interactive_tool",
    // ...
    async execute(_id, params, _signal, _onUpdate, ctx) {
      pi.events.emit("user-prompted", { tool: "my_interactive_tool" });
      const result = await ctx.ui.custom(/* ... */);
      // ...
    },
  });
}
```

**Why:** `extensions/task-continuation-reminder/index.ts` listens for this event to suppress same-run automatic follow-ups while the agent is waiting for the user to answer a blocking prompt.

**When to emit:**
- Tool calls `ctx.ui.custom()`, `ctx.ui.confirm()`, `ctx.ui.select()`, `ctx.ui.input()`, or `ctx.ui.editor()` during `execute()`.
- Emit before the first blocking prompt shown to the user.

**When NOT to emit:**
- Commands (`registerCommand`) — these are already user-initiated, not LLM-initiated.
- Tools that only use `ctx.ui.setWidget()` or `ctx.ui.notify()` — non-blocking display updates.
- Repeatedly before every follow-up prompt in same tool execution.

**Payload:** `{ tool: string }` — tool name for debugging/logging.

## Persisted waiting state vs event signal

Use `user-prompted` only for **current-run** blocking prompts. If waiting state survives beyond current tool call or prompt cycle, persist state instead of relying on an event alone.

Preferred persisted shape for generic waiting state:

```typescript
awaitingUserAction: {
  kind: string,
  suppressContinuationReminder: true,
}
```

Current repo behavior:
- `extensions/task-continuation-reminder/index.ts` suppresses reminders for same-run `user-prompted`.
- It also suppresses reminders when latest `agent-mode` state contains `awaitingUserAction.suppressContinuationReminder === true`.
- `planReviewPending` is supported for current plan-review flow compatibility, but new generic waiting flows should prefer `awaitingUserAction`.

## Current event families

| Family | Purpose | Contract | Scope |
|--------|---------|----------|-------|
| `user-prompted` | Blocking LLM-tool prompt started | `{ tool: string }` | Public shared semantic |
| `subagents:*` | Subagent lifecycle + discovery broadcasts | Event-specific payloads; keep stable core fields like `id`, `type`, `description` where applicable | Public cross-extension |
| `subagents:rpc:*` | Subagent ping / spawn / stop RPC | Request includes `requestId`; reply on `:reply:${requestId}` with success/error envelope | Public cross-extension |
| `handoff:rpc:prepare` | Direct handoff bridge | Same scoped reply-channel RPC contract | Repo-internal unless explicitly reused |
| `tasks:rpc:*` | Task-specific integration helpers | Same scoped reply-channel RPC contract | Internal |

