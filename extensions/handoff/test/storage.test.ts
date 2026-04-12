import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempHome = "";
const originalHome = process.env.HOME;

async function loadConfigModule() {
  vi.resetModules();
  return await import("../src/config.js");
}

describe("handoff config persistence", () => {
  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "handoff-config-"));
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("returns defaults when config file is missing", async () => {
    const { HANDOFF_CONFIG_PATH, loadHandoffConfig } = await loadConfigModule();
    expect(loadHandoffConfig()).toEqual({});
    await expect(readFile(HANDOFF_CONFIG_PATH, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists last summary model choice", async () => {
    const { HANDOFF_CONFIG_PATH, loadHandoffConfig, updateHandoffConfig } = await loadConfigModule();
    updateHandoffConfig({ lastSummaryModel: "anthropic/claude-haiku-4-5" });
    expect(loadHandoffConfig()).toEqual({ lastSummaryModel: "anthropic/claude-haiku-4-5" });
    await expect(readFile(HANDOFF_CONFIG_PATH, "utf8")).resolves.toContain("claude-haiku-4-5");
  });
});
