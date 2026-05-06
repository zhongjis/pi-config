import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import superpowersExtension from "../index.js";

describe("superpowers extension", () => {
  it("registers a resources_discover handler that points at the bundled skills dir", async () => {
    const mock = createMockPi();
    superpowersExtension(mock.pi as never);

    const handlers = mock.lifecycleHandlers.get("resources_discover");
    expect(handlers).toBeDefined();
    expect(handlers?.length).toBe(1);

    const result = (await handlers?.[0]?.({ cwd: process.cwd(), reason: "startup" }, {})) as {
      skillPaths: string[];
    };

    expect(result.skillPaths).toHaveLength(1);
    const skillsPath = result.skillPaths[0];
    expect(skillsPath).toMatch(/extensions\/superpowers\/skills$/);
    expect(existsSync(skillsPath)).toBe(true);
    expect(existsSync(join(skillsPath, "using-superpowers", "SKILL.md"))).toBe(true);
  });
});
