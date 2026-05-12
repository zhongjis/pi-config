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
});
