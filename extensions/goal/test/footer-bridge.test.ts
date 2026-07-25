// Repo-local test (not vendored from upstream): verifies the cross-extension footer
// integration with the `qol` extension. See AGENTS.md "Local Tweaks".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Goal } from "../src/goal/types.js";
import { updateGoalUi } from "../src/goal/ui.js";

const GOAL_FOOTER_BRIDGE_KEY = Symbol.for("pi-goal:footer");
const VISUALS_FOOTER_OWNER_KEY = Symbol.for("pi-visuals:footer");

type GoalFooterBridge = {
	getIndicator(isIdle: boolean): { text: string; color: string } | null;
};

type FooterComponent = {
	render(width: number): string[];
};

type FooterFactory = (
	tui: unknown,
	theme: { fg(color: string, text: string): string },
	footerData: {
		getAvailableProviderCount(): number;
		getExtensionStatuses(): ReadonlyMap<string, string>;
		getGitBranch(): string | null;
	},
) => FooterComponent;

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

function createMockCtx(initialIdle = false): {
	ctx: never;
	footerFactories: Array<FooterFactory | undefined>;
	setIdle(idle: boolean): void;
} {
	let idle = initialIdle;
	const footerFactories: Array<FooterFactory | undefined> = [];
	const ctx = {
		hasUI: true,
		isIdle: () => idle,
		model: undefined,
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => ({ contextWindow: 200_000, percent: 0 }),
		sessionManager: {
			getCwd: () => "/workspace",
			getEntries: () => [],
			getSessionName: () => undefined,
		},
		ui: {
			setWidget(): void {},
			setStatus(): void {},
			setFooter(factory: FooterFactory | undefined): void {
				footerFactories.push(factory);
			},
		},
	};
	return {
		ctx: ctx as never,
		footerFactories,
		setIdle(nextIdle: boolean): void {
			idle = nextIdle;
		},
	};
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

describe("goal ⇄ qol footer bridge", () => {
	beforeEach(() => {
		delete globals()[VISUALS_FOOTER_OWNER_KEY];
		delete globals()[GOAL_FOOTER_BRIDGE_KEY];
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
		delete globals()[VISUALS_FOOTER_OWNER_KEY];
		delete globals()[GOAL_FOOTER_BRIDGE_KEY];
	});

	it("defers to qol and publishes an idle-aware indicator", () => {
		setVisualsOwnsFooter(true);
		const { ctx, footerFactories } = createMockCtx();

		updateGoalUi(ctx, activeGoal({ id: "owned" }));

		expect(footerFactories).toHaveLength(0);
		expect(readBridge()?.getIndicator(false)).toEqual({
			color: "accent",
			text: "Pursuing goal (0s)",
		});
	});

	it("advances while busy and freezes while idle", () => {
		setVisualsOwnsFooter(true);
		const { ctx } = createMockCtx();
		updateGoalUi(ctx, activeGoal({ id: "idle-aware" }));

		expect(readBridge()?.getIndicator(false)?.text).toBe("Pursuing goal (0s)");
		vi.setSystemTime(5_000);
		expect(readBridge()?.getIndicator(false)?.text).toBe("Pursuing goal (5s)");
		vi.setSystemTime(10_000);
		expect(readBridge()?.getIndicator(true)?.text).toBe("Pursuing goal (5s)");
		vi.setSystemTime(15_000);
		expect(readBridge()?.getIndicator(true)?.text).toBe("Pursuing goal (5s)");
	});

	it("keeps the presentation high-water across stale same-ID persisted refreshes", () => {
		setVisualsOwnsFooter(true);
		const { ctx } = createMockCtx();
		updateGoalUi(ctx, activeGoal({ id: "stale", timeUsedSeconds: 10 }));

		vi.setSystemTime(5_000);
		expect(readBridge()?.getIndicator(false)?.text).toBe("Pursuing goal (15s)");
		const stalePersistedGoal = activeGoal({ id: "stale", timeUsedSeconds: 12, updatedAt: 1 });
		updateGoalUi(ctx, stalePersistedGoal);

		expect(readBridge()?.getIndicator(false)?.text).toBe("Pursuing goal (15s)");
		expect(stalePersistedGoal.timeUsedSeconds).toBe(12);
	});

	it("adopts a newer persisted baseline for the same goal", () => {
		setVisualsOwnsFooter(true);
		const { ctx } = createMockCtx();
		updateGoalUi(ctx, activeGoal({ id: "newer" }));

		vi.setSystemTime(5_000);
		expect(readBridge()?.getIndicator(false)?.text).toBe("Pursuing goal (5s)");
		updateGoalUi(ctx, activeGoal({ id: "newer", timeUsedSeconds: 20, updatedAt: 2 }));
		expect(readBridge()?.getIndicator(false)?.text).toBe("Pursuing goal (20s)");
		vi.setSystemTime(10_000);
		expect(readBridge()?.getIndicator(false)?.text).toBe("Pursuing goal (25s)");
	});

	it("resets presentation elapsed time for a new goal ID", () => {
		setVisualsOwnsFooter(true);
		const { ctx } = createMockCtx();
		updateGoalUi(ctx, activeGoal({ id: "old" }));
		vi.setSystemTime(5_000);
		expect(readBridge()?.getIndicator(false)?.text).toBe("Pursuing goal (5s)");

		updateGoalUi(ctx, activeGoal({ id: "new" }));
		expect(readBridge()?.getIndicator(false)?.text).toBe("Pursuing goal (0s)");
	});

	it("does not advance inactive goals and keeps absent goals null", () => {
		setVisualsOwnsFooter(true);
		const { ctx } = createMockCtx();
		updateGoalUi(ctx, activeGoal({ id: "paused", status: "paused", timeUsedSeconds: 5 }));

		vi.setSystemTime(5_000);
		expect(readBridge()?.getIndicator(false)?.text).toBe("Goal paused (/goal resume)");
		updateGoalUi(ctx, null);
		vi.setSystemTime(10_000);
		expect(readBridge()?.getIndicator(false)).toBeNull();
	});

	it("uses the same idle-aware elapsed materialization in the standalone footer", () => {
		setVisualsOwnsFooter(false);
		const { ctx, footerFactories, setIdle } = createMockCtx();
		updateGoalUi(ctx, activeGoal({ id: "standalone" }));
		const footerFactory = footerFactories.find((factory): factory is FooterFactory => typeof factory === "function");
		const component = footerFactory?.(
			{},
			{ fg: (_color, text) => text },
			{
				getAvailableProviderCount: () => 1,
				getExtensionStatuses: () => new Map(),
				getGitBranch: () => null,
			},
		);

		expect(component?.render(80).join("\n")).toContain(readBridge()?.getIndicator(false)?.text);
		vi.setSystemTime(5_000);
		expect(component?.render(80).join("\n")).toContain("Pursuing goal (5s)");
		setIdle(true);
		vi.setSystemTime(10_000);
		expect(component?.render(80).join("\n")).toContain("Pursuing goal (5s)");
		expect(readBridge()?.getIndicator(true)?.text).toBe("Pursuing goal (5s)");
	});
});
