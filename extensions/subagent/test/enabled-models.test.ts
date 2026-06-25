import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnabledModels, isModelInScope, decideModelScope } from "../src/enabled-models.js";

describe("readEnabledModels", () => {
  it("project overrides global (returns project array)", () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-"));
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }), "utf-8");
    expect(readEnabledModels(dir)).toEqual(["anthropic/claude-haiku-4-5"]);
  });
  it("undefined when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-empty-"));
    expect(readEnabledModels(dir)).toBeUndefined();
  });
});

describe("isModelInScope", () => {
  it("case-insensitive provider/id membership", () => {
    const allowed = new Set(["anthropic/claude-haiku-4-5"]);
    expect(isModelInScope({ provider: "Anthropic", id: "Claude-Haiku-4-5" }, allowed)).toBe(true);
    expect(isModelInScope({ provider: "anthropic", id: "claude-opus-4-6" }, allowed)).toBe(false);
  });
});

describe("decideModelScope", () => {
  const allowed = new Set(["anthropic/claude-haiku-4-5"]);
  it("allows when no allowlist (no-op)", () => {
    expect(decideModelScope({ model: { provider: "anthropic", id: "x" }, modelFromParams: true, allowed: undefined }).action).toBe("allow");
  });
  it("allows when in scope", () => {
    expect(decideModelScope({ model: { provider: "anthropic", id: "claude-haiku-4-5" }, modelFromParams: true, allowed }).action).toBe("allow");
  });
  it("blocks a caller-supplied out-of-scope model", () => {
    const d = decideModelScope({ model: { provider: "anthropic", id: "claude-opus-4-6" }, modelFromParams: true, allowed });
    expect(d.action).toBe("block");
    expect(d.action === "block" && d.message).toContain("anthropic/claude-haiku-4-5");
  });
  it("warns (does not block) a frontmatter/inherited out-of-scope model", () => {
    const d = decideModelScope({ model: { provider: "anthropic", id: "claude-opus-4-6" }, modelFromParams: false, allowed });
    expect(d.action).toBe("warn");
  });
});
