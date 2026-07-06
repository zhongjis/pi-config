import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import pmMarketplaceExtension from "../index.js";

describe("pm-marketplace extension", () => {
  function registeredHandler() {
    const mock = createMockPi();
    pmMarketplaceExtension(mock.pi as never);

    const handlers = mock.lifecycleHandlers.get("resources_discover");
    expect(handlers).toBeDefined();
    expect(handlers?.length).toBe(1);
    return handlers![0]!;
  }

  function setupExtension() {
    const mock = createMockPi();
    pmMarketplaceExtension(mock.pi as never);
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

  it("returns 7 per-plugin skill paths when latest persisted mode is shennong", async () => {
    const handler = registeredHandler();

    const result = (await handler({ cwd: process.cwd(), reason: "startup" }, ctxWithMode("shennong"))) as {
      skillPaths: string[];
    };

    expect(result.skillPaths).toHaveLength(7);

    for (const skillsPath of result.skillPaths) {
      expect(skillsPath).toMatch(/pm-marketplace\/pm-skills\/[^/]+\/skills$/);
      expect(existsSync(skillsPath)).toBe(true);
    }

    // Verify a known skill inside one of the paths exists
    const execSkills = result.skillPaths.find((p) => p.includes("pm-execution"));
    expect(execSkills).toBeDefined();
    expect(existsSync(join(execSkills!, "create-prd", "SKILL.md"))).toBe(true);
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

  // --- Frontmatter parsing (via command registration) ---

  it("registers pm:* commands from frontmatter descriptions", () => {
    const mock = setupExtension();
    const commands = Array.from(mock.commands.keys());

    // All commands use pm: prefix
    expect(commands.every((c) => c.startsWith("pm:"))).toBe(true);
    expect(commands.length).toBeGreaterThan(0);

    // Known commands from pm-execution plugin
    expect(commands).toContain("pm:write-prd");
    expect(commands).toContain("pm:write-stories");

    // Command from pm-product-discovery plugin
    expect(commands).toContain("pm:discover");
  });

  it("registers commands from at least 3 different plugins", () => {
    const mock = setupExtension();
    const commands = Array.from(mock.commands.keys());

    // pm-execution commands
    expect(commands).toContain("pm:write-prd");
    // pm-data-analytics commands
    expect(commands).toContain("pm:analyze-cohorts");
    // pm-market-research commands
    expect(commands).toContain("pm:analyze-feedback");
  });

  it("total registered commands is at least 30", () => {
    const mock = setupExtension();
    expect(mock.commands.size).toBeGreaterThanOrEqual(30);
  });
});
