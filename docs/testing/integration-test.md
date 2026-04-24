# Integration Testing

Integration tests run extensions inside the **real pi runtime** using [@marcfargas/pi-test-harness](https://github.com/marcfargas/pi-test-harness). Extensions load, register, and hook into actual pi code paths — only the LLM and optionally tool execution are replaced.

## Location

- `test/integration/` — all integration test files
- `vitest.config.ts` — vitest config with `integration` project (no stub aliases, real pi packages)

## Running

```bash
pnpm test:integration   # run integration tests only
pnpm test               # run both unit + integration
```

## How It Works

pi-test-harness substitutes three boundary points while keeping everything else real:

| What | Substituted with | Purpose |
|------|-----------------|---------|
| `streamFn` | Playbook | Scripts what the model "decides" |
| `tool.execute()` | Mock handler | Controls what tools "return" (hooks still fire) |
| `ctx.ui.*` | Mock UI | Controls what the user "answers" |

```
┌─────────────────────────────────────────┐
│  Real pi environment                    │
│                                         │
│  Extensions ─── loaded for real         │
│  Tool registry ─ real hooks + wrapping  │
│  Session state ─ in-memory persistence  │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │  streamFn ── REPLACED by playbook │  │
│  │  tool.execute() INTERCEPTED       │  │
│  │  ctx.ui.* ── INTERCEPTED + logged │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

## Dependencies

These are in root `devDependencies` (aligned with nix pi version):

```
@marcfargas/pi-test-harness  — test harness (git dep)
@mariozechner/pi-coding-agent — real pi runtime
@mariozechner/pi-ai           — real AI types
@mariozechner/pi-agent-core   — real agent core
```

## Playbook DSL

### `when(prompt, actions)` — defines a conversation turn

```typescript
when("Deploy the app", [
  calls("bash", { command: "npm run build" }),
  calls("bash", { command: "gcloud run deploy" }),
  says("Deployed successfully."),
])
```

### `calls(tool, params)` — model calls a tool

Pi's hooks fire, the tool executes (real or mocked), result feeds back.

### `says(text)` — model emits text, turn ends

### Multi-turn conversations

```typescript
await t.run(
  when("What files?", [
    calls("bash", { command: "ls" }),
    says("Found 3 files."),
  ]),
  when("Read the README", [
    calls("read", { path: "README.md" }),
    says("Here's what it says..."),
  ]),
);
```

## Writing Integration Tests

### Basic pattern

```typescript
import { describe, it, expect, afterEach } from "vitest";
import {
  createTestSession,
  when, calls, says,
  type TestSession,
} from "@marcfargas/pi-test-harness";

describe("my-extension integration", () => {
  let t: TestSession;
  afterEach(() => t?.dispose());

  it("loads and registers tools", async () => {
    t = await createTestSession({
      extensions: ["./extensions/my-ext/src/index.ts"],
      mockTools: {
        bash: (params) => `$ ${params.command}\noutput`,
        read: "file contents",
        write: "written",
        edit: "edited",
      },
    });

    await t.run(
      when("Do something", [
        calls("bash", { command: "ls" }),
        says("Done."),
      ]),
    );

    expect(t.events.toolResultsFor("bash")).toHaveLength(1);
  });
});
```

### Mock tools

```typescript
mockTools: {
  bash: "static output",                          // static string
  read: (params) => `contents of ${params.path}`, // dynamic function
  write: {                                         // full ToolResult
    content: [{ type: "text", text: "Written" }],
    details: { bytesWritten: 42 },
  },
}
```

Extension-registered tools execute for real unless listed in `mockTools`.

### Mock UI

```typescript
mockUI: {
  confirm: false,
  select: 0,
  input: "user input",
}
```

### Event assertions

```typescript
t.events.toolCallsFor("bash")     // ToolCallRecord[]
t.events.toolResultsFor("bash")   // ToolResultRecord[]
t.events.blockedCalls()            // tools blocked by hooks
t.events.uiCallsFor("confirm")    // UICallRecord[]
t.events.messages                  // AgentMessage[]
```

### Late-bound params

When one tool call produces a value needed by the next:

```typescript
let id = "";
await t.run(
  when("Create and use", [
    calls("create_thing", { name: "test" })
      .then((result) => { id = result.text.match(/ID-\w+/)![0]; }),
    calls("use_thing", () => ({ id })),
    says("Done."),
  ]),
);
```

## Which Extensions Need Integration Tests

| Priority | Extension | Why |
|----------|-----------|-----|
| High | `modes/` | Complex hook interaction, plan-mode blocking, delegation filtering |
| High | `handoff/` | Protocol lifecycle, session boundary crossing, bridge RPC |
| Medium | `tasks/` | Session state, subagent events, auto-clear logic |
| Medium | `subagent/` | Background supervision, delegation policy |
| Low | Simple extensions | Smoke test + unit tests sufficient |

## Gotchas

- **Timeout**: integration tests use 30s timeout (vs default 5s for unit tests)
- **Cleanup**: always call `t?.dispose()` in `afterEach` to clean up temp directories
- **Session boundaries**: pi-test-harness runs in-process — actual session switching (new process) cannot be tested. Test the logic up to the boundary.
- **Agent configs**: if extension reads agent `.md` files, ensure `createTestSession` can find them (may need `configDir` option)
- **Version alignment**: pi packages in `devDependencies` must match nix pi version to avoid skew
- **pnpm patch**: `patches/@marcfargas__pi-test-harness@0.5.0.patch` fixes 3 compat issues with pi 0.67 (`setTools` → `state.tools`, auth mock methods). If pi-test-harness updates, re-check whether the patch is still needed.
