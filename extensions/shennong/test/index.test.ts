import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import shennongExtension from "../index.js";

describe("shennong extension", () => {
  function registeredHandler() {
    const mock = createMockPi();
    shennongExtension(mock.pi as never);

    const handlers = mock.lifecycleHandlers.get("resources_discover");
    expect(handlers).toBeDefined();
    expect(handlers?.length).toBe(1);
    return handlers![0]!;
  }

  function setupExtension() {
    const mock = createMockPi();
    shennongExtension(mock.pi as never);
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

  it("does not expose pm-skills outside shennong mode", async () => {
    const handler = registeredHandler();

    const result = (await handler({ cwd: process.cwd(), reason: "startup" }, ctxWithMode("kuafu"))) as {
      skillPaths: string[];
    };

    expect(result.skillPaths).toEqual([]);
  });

  it("points at the pm-skills dir when latest persisted mode is shennong", async () => {
    const handler = registeredHandler();

    const result = (await handler({ cwd: process.cwd(), reason: "startup" }, ctxWithMode("shennong"))) as {
      skillPaths: string[];
    };

    expect(result.skillPaths).toHaveLength(1);
    const skillsPath = result.skillPaths[0];
    expect(skillsPath).toMatch(/extensions\/shennong\/pm-skills$/);
    expect(existsSync(skillsPath)).toBe(true);
    expect(existsSync(join(skillsPath, "pm-execution", "create-prd", "SKILL.md"))).toBe(true);
  });

  it("uses the latest persisted agent-mode entry", async () => {
    const handler = registeredHandler();

    const result = (await handler({ cwd: process.cwd(), reason: "reload" }, {
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "agent-mode", data: { mode: "shennong" } },
          { type: "custom", customType: "agent-mode", data: { mode: "kuafu" } },
        ],
      },
    })) as { skillPaths: string[] };

    expect(result.skillPaths).toEqual([]);
  });

  it("context handler returns undefined and does not throw for non-shennong mode", async () => {
    const mock = setupExtension();
    const handler = mock.lifecycleHandlers.get("context")![0]!;
    const result = await handler({ messages: [] }, ctxWithMode("kuafu"));
    expect(result).toBeUndefined();
  });
});
