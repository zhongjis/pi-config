# Extension Conventions

## Event Bus: `user-prompted`

Any **LLM-callable tool** (`registerTool`) that blocks on user input must emit
`pi.events.emit("user-prompted", { tool: "<name>" })` **before** showing the
interactive UI.

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

**Why:** The task continuation reminder (and potentially other extensions) listens
for this event to suppress automatic follow-ups while the user is being prompted.
Without it, a continuation reminder fires immediately after the agent ends,
overriding the natural conversational flow of a user answering a question.

**When to emit:**
- Tool calls `ctx.ui.custom()`, `ctx.ui.confirm()`, `ctx.ui.select()`,
  `ctx.ui.input()`, or `ctx.ui.editor()` during its `execute` function.

**When NOT to emit:**
- Commands (`registerCommand`) — these are user-initiated, not LLM-initiated.
- Tools that use `ctx.ui.setWidget()` or `ctx.ui.notify()` — these are
  non-blocking display updates, not interactive prompts.

**Payload:** `{ tool: string }` — the tool name, for debugging/logging.

**Listeners:**
- `extensions/task-continuation-reminder/index.ts` — suppresses continuation reminders
  for the current agent run when this event fires.
