# Unit Testing

Unit tests validate extension logic in isolation using hand-rolled stubs instead of real pi packages.

## Location

- `extensions/*/test/` — per-extension unit tests
- `test/extensions.smoke.test.ts` — auto-discovery smoke test for all extensions
- `test/stubs/` — stub modules for `@mariozechner/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`
- `test/fixtures/` — `mock-pi.ts`, `mock-context.ts`

## Running

```bash
pnpm test:extensions        # run all unit tests
pnpm test:extensions:watch  # watch mode
```

These run the `unit` vitest project (defined in `vitest.config.ts`).

## How It Works

The unit project uses `resolve.alias` to redirect all `@mariozechner/*` imports to local stubs in `test/stubs/`. Extensions never touch real pi internals — they get fake `Pi` objects, fake `Context`, and fake lifecycle events.

```
extensions/modes/src/index.ts
       ↓ imports @mariozechner/pi-coding-agent
       ↓ vitest resolves → test/stubs/pi-coding-agent.ts
       ↓ receives mock types and utilities
```

`test/setup-require-stubs.ts` patches `Module._resolveFilename` for CJS `require()` calls that bypass vitest's ESM aliases.

## Smoke Test

`test/extensions.smoke.test.ts` auto-discovers all extension entrypoints and validates:

1. Module imports without error
2. Default export is callable
3. Extension registers ≥1 command, tool, provider, renderer, shortcut, widget, flag, or lifecycle hook
4. Common lifecycle hooks (`session_start`, `session_switch`, `session_tree`, `session_shutdown`) fire without error

The smoke test is intentionally shallow and broad — it catches load regressions, not behavior bugs.

## Writing Unit Tests

### When to add unit tests

Add focused tests when an extension has:

- State transitions
- Parsing or argument handling
- File or session persistence
- Cross-extension coordination
- Non-trivial lifecycle behavior

### Pattern

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createMockPi } from "../../test/fixtures/mock-pi";

describe("my-extension", () => {
  let pi: ReturnType<typeof createMockPi>;

  beforeEach(() => {
    pi = createMockPi();
  });

  it("registers a command", async () => {
    const ext = await import("../src/index");
    await ext.default(pi);
    expect(pi.commands).toContainEqual(
      expect.objectContaining({ name: "my-command" })
    );
  });
});
```

### Key stubs

| Stub | Provides |
|------|----------|
| `test/stubs/pi-ai.ts` | `API`, `Model`, `Message` types, `complete()`, `getModel()` |
| `test/stubs/pi-coding-agent.ts` | `Pi` type, extension registration types |
| `test/stubs/pi-agent-core.ts` | Core agent types |
| `test/stubs/pi-tui.ts` | TUI rendering types |
| `test/fixtures/mock-pi.ts` | Full mock `Pi` object with lifecycle, commands, tools, events |
| `test/fixtures/mock-context.ts` | Mock `Context` with UI, session manager |

## Maintenance

- When adding a new extension, ensure it's compatible with the smoke harness
- When adding a new stub type, add it to the appropriate `test/stubs/*.ts` file
- Keep the smoke test cheap — focused behavior belongs in extension-local tests
