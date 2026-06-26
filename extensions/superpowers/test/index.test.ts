import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import superpowersExtension from "../index.js";

describe("superpowers extension", () => {
  function registeredHandler() {
    const mock = createMockPi();
    superpowersExtension(mock.pi as never);

    const handlers = mock.lifecycleHandlers.get("resources_discover");
    expect(handlers).toBeDefined();
    expect(handlers?.length).toBe(1);
    return handlers![0]!;
  }

  function setupExtension() {
    const mock = createMockPi();
    superpowersExtension(mock.pi as never);
    return mock;
  }

  function ctxWithMode(mode?: string) {
    return {
      sessionManager: {
        getEntries: () =>
          mode
            ? [{ type: "custom", customType: "agent-mode", data: { mode } }]
            : [],
      },
    };
  }

  it("does not expose bundled skills outside luban mode", async () => {
    const handler = registeredHandler();

    const result = (await handler({ cwd: process.cwd(), reason: "startup" }, ctxWithMode("kuafu"))) as {
      skillPaths: string[];
    };

    expect(result.skillPaths).toEqual([]);
  });

  it("points at the bundled skills dir when latest persisted mode is luban", async () => {
    const handler = registeredHandler();

    const result = (await handler({ cwd: process.cwd(), reason: "startup" }, ctxWithMode("luban"))) as {
      skillPaths: string[];
    };

    expect(result.skillPaths).toHaveLength(1);
    const skillsPath = result.skillPaths[0];
    expect(skillsPath).toMatch(/extensions\/superpowers\/skills$/);
    expect(existsSync(skillsPath)).toBe(true);
    expect(existsSync(join(skillsPath, "using-superpowers", "SKILL.md"))).toBe(true);
  });

  it("uses the latest persisted agent-mode entry", async () => {
    const handler = registeredHandler();

    const result = (await handler({ cwd: process.cwd(), reason: "reload" }, {
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "agent-mode", data: { mode: "luban" } },
          { type: "custom", customType: "agent-mode", data: { mode: "kuafu" } },
        ],
      },
    })) as { skillPaths: string[] };

    expect(result.skillPaths).toEqual([]);
  });

  it("context handler injects bootstrap message when luban mode", async () => {
    const mock = setupExtension();
    const handler = mock.lifecycleHandlers.get("context")![0]!;
    const result = (await handler({ messages: [] }, ctxWithMode("luban"))) as { messages: unknown[] } | undefined;
    expect(result).toBeDefined();
    expect(result?.messages).toHaveLength(1);
  });

  it("context handler skips bootstrap injection when not luban", async () => {
    const mock = setupExtension();
    const handler = mock.lifecycleHandlers.get("context")![0]!;
    const result = await handler({ messages: [] }, ctxWithMode("kuafu"));
    expect(result).toBeUndefined();
  });

  it("bootstrap message contains BOOTSTRAP_MARKER", async () => {
    const mock = setupExtension();
    const handler = mock.lifecycleHandlers.get("context")![0]!;
    const result = (await handler({ messages: [] }, ctxWithMode("luban"))) as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    const text = result.messages[0]!.content[0]!.text;
    expect(text).toContain("superpowers:using-superpowers bootstrap for pi");
  });

  it("bootstrap message contains piToolMapping content", async () => {
    const mock = setupExtension();
    const handler = mock.lifecycleHandlers.get("context")![0]!;
    const result = (await handler({ messages: [] }, ctxWithMode("luban"))) as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    const text = result.messages[0]!.content[0]!.text;
    expect(text).toMatch(/`Agent`|TaskCreate/);
  });

  it("session_start resets injectBootstrap so context injects again", async () => {
    const mock = setupExtension();
    const handler = mock.lifecycleHandlers.get("context")![0]!;

    // agent_end sets injectBootstrap = false
    await mock.fireLifecycle("agent_end");

    // context must not inject when flag is false
    const afterEnd = await handler({ messages: [] }, ctxWithMode("luban"));
    expect(afterEnd).toBeUndefined();

    // session_start resets flag to true
    await mock.fireLifecycle("session_start");

    // context injects again
    const afterStart = (await handler({ messages: [] }, ctxWithMode("luban"))) as { messages: unknown[] };
    expect(afterStart?.messages).toHaveLength(1);
  });
});
