import { describe, expect, it } from "vitest";
import { buildAgentToolDescription } from "../src/agent-tool-description.js";

const full = "- general-purpose: Does everything.";
const compact = "- general-purpose: Does everything.";

describe("buildAgentToolDescription", () => {
  it("full mode embeds the full type list and the guideline bullets", () => {
    const out = buildAgentToolDescription("full", full, compact);
    expect(out).toContain("- general-purpose: Does everything.");
    expect(out).toContain("run_in_background controls when Agent returns");
    expect(out).toContain("agent type's configured run_in_background takes precedence");
    expect(out).toContain("Effective false waits for completion and returns the final result");
    expect(out).toContain("Effective true returns an agent ID immediately");
    expect(out).toContain("does not control sibling tool scheduling");
    expect(out).toContain("Pi's default parallel tool mode");
    expect(out).toContain("sequential tool mode runs them one at a time");
    expect(out).toContain("Background runs may queue at the configured concurrency limit");
    expect(out).toContain("foreground runs bypass that queue");
    expect(out).not.toContain("result delivery, not serialization");
    expect(out).toContain("inherit_context");
    expect(out).toContain("resume only for the same workstream");
    expect(out).toContain("follow-up, correction, or recheck");
    expect(out).toContain("fresh agent for independent or unrelated work");
    expect(out).toContain("do not automatically fall back to a fresh call");
  });

  it("compact mode is materially shorter and uses the compact list", () => {
    const fullOut = buildAgentToolDescription("full", full, compact);
    const compactOut = buildAgentToolDescription("compact", full, compact);
    expect(compactOut.length).toBeLessThan(fullOut.length * 0.6);
    expect(compactOut).toContain("- general-purpose: Does everything.");
    expect(compactOut).not.toContain("Available agents:");
    expect(compactOut).toContain("run_in_background controls return timing, not sibling scheduling");
    expect(compactOut).toContain("agent-type configuration overrides the call, defaulting to false");
    expect(compactOut).toContain("Effective false waits for the final result");
    expect(compactOut).toContain("effective true returns an agent ID immediately");
    expect(compactOut).toContain("Pi's default parallel tool mode can overlap sibling calls");
    expect(compactOut).toContain("sequential mode cannot");
    expect(compactOut).toContain("Background runs may queue; foreground runs bypass that queue");
    expect(compactOut).not.toContain("result delivery, not serialization");
    expect(compactOut).toContain("Resume only the same workstream");
    expect(compactOut).toContain("follow-up, correction, recheck");
    expect(compactOut).toContain("fresh for independent/unrelated work");
    expect(compactOut).toContain("do not auto-fallback to fresh");
  });
});
