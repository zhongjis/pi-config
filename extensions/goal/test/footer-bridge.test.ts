// Repo-local test (not vendored from upstream): verifies the cross-extension footer
// integration with the `visuals` extension. See AGENTS.md "Local Tweaks".
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Goal } from "../src/goal/types.js";
import { updateGoalUi } from "../src/goal/ui.js";

const GOAL_FOOTER_BRIDGE_KEY = Symbol.for("pi-goal:footer");
const VISUALS_FOOTER_OWNER_KEY = Symbol.for("pi-visuals:footer");

type GoalFooterBridge = {
	getIndicator(): { text: string; color: string } | null;
};

function globals(): Record<symbol, unknown> {
	return globalThis as unknown as Record<symbol, unknown>;
}

function setVisualsOwnsFooter(owns: boolean): void {
	if (owns) {
		globals()[VISUALS_FOOTER_OWNER_KEY] = true;
	} else {
		delete globals()[VISUALS_FOOTER_OWNER_KEY];
	}
}

function readBridge(): GoalFooterBridge | undefined {
	return globals()[GOAL_FOOTER_BRIDGE_KEY] as GoalFooterBridge | undefined;
}

function createMockCtx(): { ctx: never; footerFactories: unknown[] } {
	const footerFactories: unknown[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			setWidget(): void {},
			setStatus(): void {},
			setFooter(factory: unknown): void {
				footerFactories.push(factory);
			},
		},
	};
	return { ctx: ctx as never, footerFactories };
}

function activeGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		threadId: "thread-1",
		objective: "do the thing",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

describe("goal ⇄ visuals footer bridge", () => {
	beforeEach(() => {
		delete globals()[VISUALS_FOOTER_OWNER_KEY];
		delete globals()[GOAL_FOOTER_BRIDGE_KEY];
	});

	afterEach(() => {
		delete globals()[VISUALS_FOOTER_OWNER_KEY];
		delete globals()[GOAL_FOOTER_BRIDGE_KEY];
	});

	it("defers to visuals (installs no footer of its own) when visuals owns the footer", () => {
		setVisualsOwnsFooter(true);
		const { ctx, footerFactories } = createMockCtx();

		updateGoalUi(ctx, activeGoal());

		expect(footerFactories).toHaveLength(0);
		const indicator = readBridge()?.getIndicator();
		expect(indicator?.text.startsWith("Pursuing goal")).toBe(true);
		expect(indicator?.color).toBe("accent");
	});

	it("installs its own footer as a standalone fallback when visuals is absent", () => {
		setVisualsOwnsFooter(false);
		const { ctx, footerFactories } = createMockCtx();

		updateGoalUi(ctx, activeGoal());

		expect(footerFactories).toHaveLength(1);
		expect(typeof footerFactories[0]).toBe("function");
	});

	it("publishes a null indicator when there is no active goal", () => {
		setVisualsOwnsFooter(true);
		const { ctx, footerFactories } = createMockCtx();

		updateGoalUi(ctx, null);

		expect(footerFactories).toHaveLength(0);
		expect(readBridge()?.getIndicator()).toBeNull();
	});
});
