import { describe, expect, it } from "vitest";
import { buildAgentToolDescription } from "../src/agent-tool-description.js";

const full = "- general-purpose: Does everything.";
const compact = "- general-purpose: Does everything.";

describe("buildAgentToolDescription", () => {
  it("full mode embeds the full type list and the guideline bullets", () => {
    const out = buildAgentToolDescription("full", full, compact);
    expect(out).toContain("- general-purpose: Does everything.");
    expect(out).toContain("run_in_background: false waits for completion");
    expect(out).toContain("controls result delivery, not serialization");
    expect(out).toContain("dispatched concurrently can overlap in either mode");
    expect(out).not.toContain("Foreground calls run sequentially");
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
    expect(compactOut).toContain("run_in_background:false waits for completion");
    expect(compactOut).toContain("controls result delivery, not serialization");
    expect(compactOut).toContain("concurrently dispatched Agent calls can overlap in either mode");
    expect(compactOut).toContain("Resume only the same workstream");
    expect(compactOut).toContain("follow-up, correction, recheck");
    expect(compactOut).toContain("fresh for independent/unrelated work");
    expect(compactOut).toContain("do not auto-fallback to fresh");
  });
});
