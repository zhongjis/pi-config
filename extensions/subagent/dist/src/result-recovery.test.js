import { describe, expect, it } from "vitest";
import { getRecoveredResultText } from "./result-recovery.js";
describe("getRecoveredResultText", () => {
    it("returns the existing result when present", () => {
        expect(getRecoveredResultText({
            status: "completed",
            result: "READY",
            error: undefined,
            toolUses: 0,
            outputFile: undefined,
            session: undefined,
        })).toBe("READY");
    });
    it("builds a useful fallback summary with transcript context", () => {
        const text = getRecoveredResultText({
            status: "stopped",
            result: "",
            error: "Parent tool signal aborted while the agent was running.",
            toolUses: 3,
            outputFile: "/tmp/test.output",
            session: {
                messages: [
                    { role: "user", content: "review the plan" },
                    {
                        role: "assistant",
                        content: [
                            { type: "text", text: "I found one likely blocker." },
                            { type: "toolCall", name: "read" },
                        ],
                    },
                ],
            },
        });
        expect(text).toContain("Agent was stopped before producing a final answer.");
        expect(text).toContain("Error: Parent tool signal aborted while the agent was running.");
        expect(text).toContain("Tool uses before exit: 3");
        expect(text).toContain("I found one likely blocker.");
        expect(text).toContain("Transcript file: /tmp/test.output");
    });
});
