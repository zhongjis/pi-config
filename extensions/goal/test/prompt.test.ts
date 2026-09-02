import { describe, expect, it } from "vitest";

import { buildBudgetLimitedPrompt, buildContinuationPrompt } from "../src/goal/prompt.js";
import type { Goal } from "../src/goal/types.js";

describe("goal prompts", () => {
	it("escapes the objective inside its XML envelope", () => {
		const prompt = buildContinuationPrompt(testGoal("A & B < C > D", { tokenBudget: 100 }));

		expect(prompt).toContain("<objective>\nA &amp; B &lt; C &gt; D\n</objective>");
		expect(prompt).not.toContain("<untrusted_objective>");
	});

	it("escapes the budget-limited objective inside its XML envelope", () => {
		const prompt = buildBudgetLimitedPrompt(
			testGoal("A & B < C > D", { status: "budgetLimited", tokenBudget: 10, tokensUsed: 12 }),
		);

		expect(prompt).toContain("<objective>\nA &amp; B &lt; C &gt; D\n</objective>");
		expect(prompt).not.toContain("<untrusted_objective>");
	});
});

function testGoal(objective: string, overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		threadId: "thread-1",
		objective,
		status: "active",
		tokensUsed: 10,
		timeUsedSeconds: 20,
		createdAt: 1_777_766_400,
		updatedAt: 1_777_766_400,
		...overrides,
	};
}
