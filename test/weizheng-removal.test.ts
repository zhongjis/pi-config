import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const REMOVED_AGENT = join(ROOT, "agents", "weizheng.md");

describe("Wei Zheng removal contract", () => {
  it("removes the custom agent definition", () => {
    expect(existsSync(REMOVED_AGENT)).toBe(false);
  });
});
