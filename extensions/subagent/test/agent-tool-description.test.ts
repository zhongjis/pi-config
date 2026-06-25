import { describe, expect, it } from "vitest";
import { buildAgentToolDescription } from "../src/agent-tool-description.js";

const full = "- general-purpose: Does everything.";
const compact = "- general-purpose: Does everything.";

describe("buildAgentToolDescription", () => {
  it("full mode embeds the full type list and the guideline bullets", () => {
    const out = buildAgentToolDescription("full", full, compact);
    expect(out).toContain("- general-purpose: Does everything.");
    expect(out).toContain("- For parallel work, use run_in_background");
    expect(out).toContain("inherit_context");
  });

  it("compact mode is materially shorter and uses the compact list", () => {
    const fullOut = buildAgentToolDescription("full", full, compact);
    const compactOut = buildAgentToolDescription("compact", full, compact);
    expect(compactOut.length).toBeLessThan(fullOut.length * 0.6);
    expect(compactOut).toContain("- general-purpose: Does everything.");
    expect(compactOut).not.toContain("Available agents:");
  });
});
