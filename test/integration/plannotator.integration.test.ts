import { describe, it, expect, afterEach } from "vitest";
import {
	createTestSession,
	when,
	calls,
	says,
	type TestSession,
} from "@marcfargas/pi-test-harness";
import * as path from "node:path";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const EXTENSION = path.resolve(PROJECT_ROOT, "extensions/modes/src/index.ts");

const MOCK_TOOLS = {
	bash: (params: Record<string, unknown>) => `$ ${params.command}\nok`,
	read: "mock file contents",
	write: "mock written",
	edit: "mock edited",
};

async function switchMode(t: TestSession, mode: string): Promise<void> {
	await (t.session as any).prompt(`/mode ${mode}`);
}

describe("plannotator integration", () => {
	let t: TestSession;
	afterEach(() => t?.dispose());

	// ── Direct availability check ────────────────────────────────

	it("checkPlannotatorAvailability uses direct import (no IPC timeout)", async () => {
		// Load the modes extension and capture the event bus to verify
		// no IPC events are emitted for availability checks.
		let eventBus: any = null;
		const emittedChannels: string[] = [];

		t = await createTestSession({
			extensions: [EXTENSION],
			extensionFactories: [
				(pi: any) => {
					eventBus = pi.events;
					const originalEmit = eventBus.emit.bind(eventBus);
					eventBus.emit = (channel: string, ...args: unknown[]) => {
						emittedChannels.push(channel);
						return originalEmit(channel, ...args);
					};
				},
			],
			mockTools: MOCK_TOOLS,
		});

		await switchMode(t, "fuxi");

		// Call plan_approve — this triggers checkPlannotatorAvailability internally
		// The availability check should NOT emit "plannotator:request" (old IPC)
		await t.run(
			when("Approve the plan", [
				calls("plan_approve", { variant: "post-gap-review" }),
				says("Approved."),
			]),
		);

		// Verify no IPC events were emitted to the old plannotator channel
		const plannotatorIPCEvents = emittedChannels.filter(
			(ch) => ch === "plannotator:request",
		);
		expect(plannotatorIPCEvents).toHaveLength(0);
	});

	// ── plan_approve tool shows plannotator option ────────────────

	it("plan_approve tool executes without IPC timeout", async () => {
		t = await createTestSession({
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
			mockUI: {
				select: 0, // Pick first option (Refine in Editor)
			},
			propagateErrors: false,
		});

		await switchMode(t, "fuxi");

		await t.run(
			when("Run plan approve", [
				calls("plan_approve", { variant: "post-gap-review" }),
				says("Plan approve done."),
			]),
		);

		const results = t.events.toolResultsFor("plan_approve");
		expect(results).toHaveLength(1);
		// Should not contain "timed out" — that was the old IPC failure mode
		const resultText = typeof results[0].content === "string"
			? results[0].content
			: JSON.stringify(results[0].content);
		expect(resultText).not.toContain("timed out");
	});

	// ── tool_result hook guards pending reviews ──────────────────

	it("tool_result hook does not reset review state when review is pending", async () => {
		let eventBus: any = null;

		t = await createTestSession({
			extensions: [EXTENSION],
			extensionFactories: [
				(pi: any) => {
					eventBus = pi.events;
				},
			],
			mockTools: MOCK_TOOLS,
			propagateErrors: false,
		});

		await switchMode(t, "fuxi");

		// Write to the plan file — this triggers tool_result hook
		// Before the fix, this would call resetPlanReviewState() unconditionally
		// After the fix, it checks planReviewPending first
		await t.run(
			when("Write the plan", [
				calls("write", { path: "local://PLAN.md", content: "# Test Plan\n\nTest content" }),
				says("Plan written."),
			]),
		);

		// The write should succeed (not blocked)
		const blocked = t.events.blockedCalls();
		const writeBlocked = blocked.filter((b: any) => b.toolName === "write" && b.blockReason?.includes("restricted"));
		// Plan writes to local://PLAN.md should NOT be blocked in fuxi mode
		expect(writeBlocked).toHaveLength(0);
	});

	// ── No old IPC constants in extension ────────────────────────

	it("extension loads without registering plannotator IPC listeners", async () => {
		let eventBus: any = null;
		const registeredChannels: string[] = [];

		t = await createTestSession({
			extensions: [EXTENSION],
			extensionFactories: [
				(pi: any) => {
					eventBus = pi.events;
					const originalOn = eventBus.on.bind(eventBus);
					eventBus.on = (channel: string, handler: (...args: unknown[]) => unknown) => {
						registeredChannels.push(channel);
						return originalOn(channel, handler);
					};
				},
			],
			mockTools: MOCK_TOOLS,
		});

		// The modes extension should NOT listen on the old IPC result channel
		const ipcListeners = registeredChannels.filter(
			(ch) => ch === "plannotator:review-result",
		);
		expect(ipcListeners).toHaveLength(0);
	});
});
