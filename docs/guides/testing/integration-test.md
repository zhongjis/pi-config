# Integration Testing

The `integration` Vitest project loads extensions into a real Pi session with a deterministic faux model provider. The repository's [`test/integration/helpers/faux-session.ts`](../../../test/integration/helpers/faux-session.ts) exports `createTestSession`, `when`, `calls`, and `says`. Use these local helpers rather than importing the upstream test harness directly. The real agent loop and extension hooks run; playbook actions supply model responses without network access.

## Run

```bash
pnpm test:integration
pnpm test  # all configured Vitest projects
```

Integration tests live under `test/integration/`. The project uses real Pi packages and no unit-test stub aliases; see [`vitest.config.ts`](../../../vitest.config.ts).

## Write a faux-provider playbook

This example follows the session, tool mock, and event-assertion pattern in [`modes.integration.test.ts`](../../../test/integration/modes.integration.test.ts):

```typescript
import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createTestSession, when, calls, says, type TestSession } from "./helpers/faux-session.js";

const EXTENSION = resolve(__dirname, "../../extensions/modes/src/index.ts");

describe("modes integration", () => {
  let t: TestSession;
  afterEach(() => t?.dispose());

  it("runs a model-requested tool", async () => {
    t = await createTestSession({
      extensions: [EXTENSION],
      mockTools: { bash: "mock output" },
    });
    await t.run(when("Run a command", [
      calls("bash", { command: "pwd" }),
      says("Done."),
    ]));
    expect(t.events.toolResultsFor("bash")).toHaveLength(1);
  });
});
```

The playbook supplies ordered model actions; `calls` invokes a tool and `says` completes the response. `mockTools` substitutes selected tool results while extension-registered tools and hooks still run. `mockUI` can provide answers for extension UI calls. Assert against `t.events`; `faux-session.ts` defines its query helpers. Dispose of the session after each test to release its temporary directory.

For extension calls to a separate model, [`smart-tool-guards.integration.test.ts`](../../../test/integration/smart-tool-guards.integration.test.ts) demonstrates `fauxResponseRouter`. For tests that need a different session setup, see [`fast-session.ts`](../../../test/integration/helpers/fast-session.ts) and its use in [`fast.integration.test.ts`](../../../test/integration/fast.integration.test.ts).
