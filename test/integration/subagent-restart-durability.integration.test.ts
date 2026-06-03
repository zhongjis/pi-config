// Expected runtime: < 10s (unit-style with mock pi, no real process spawning)
/**
 * @integration
 * Restart-durability suite for Phase 4 durable state.
 * Tests that PersistentBgAgentRegistry + compaction + parent linkage all survive
 * a simulated crash-and-restart using the appendEntry replay mechanism.
 *
 * The pi-test-harness exposes no SIGKILL+restart primitive, so a "crash + restart"
 * is modeled the same way the production boot path reconstructs state: a fresh
 * PersistentBgAgentRegistry (empty in-memory caches) replays the durable appendEntry
 * log. The durable log is the only thing that crosses the restart boundary — exactly
 * the Phase 4 invariant under test. Mirrors the end-to-end wiring of the Task 27/28/29
 * unit tests (bg-agent-registry-replay, compaction-survival, parent-child-linkage)
 * stitched into a single crash→restart flow across all three components.
 *
 * Expected runtime: < 10s
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pandaWarn } from "../../extensions/lib/warn.js";
import {
	BG_AGENT_REGISTRY_ENTRY_TYPE,
	type BgAgentRegistryEntry,
	PersistentBgAgentRegistry,
	TASK_CLAIM_ENTRY_TYPE,
} from "../../extensions/subagent/src/lifecycle/registry-persistence.js";

/** A mutable session JSONL log that records appended CustomEntry rows (durable across restart). */
function createSessionLog() {
	const entries: Array<{ type: "custom"; customType: string; data?: unknown }> = [];
	const pi = {
		appendEntry: vi.fn((customType: string, data?: unknown) => {
			entries.push({ type: "custom", customType, data });
		}),
	};
	return { entries, pi };
}

/**
 * Mirror of the `session_before_compact` handler registered in supervision.ts (Task 28):
 * writes a single informational marker capturing the live registry/claim sizes.
 */
function onBeforeCompact(
	pi: { appendEntry: (t: string, d?: unknown) => void },
	registry: PersistentBgAgentRegistry,
): void {
	pi.appendEntry("subagents:pre-compact-marker", {
		ts: Date.now(),
		registrySize: registry.listAgents().length,
		claimsSize: registry.listClaims().length,
	});
}

/**
 * Mirror of the `session_compact` handler registered in supervision.ts (Task 28):
 * re-emits every live registry/claim row as a fresh post-compact baseline.
 */
function onCompact(
	pi: { appendEntry: (t: string, d?: unknown) => void },
	registry: PersistentBgAgentRegistry,
): void {
	for (const agent of registry.listAgents()) {
		pi.appendEntry(BG_AGENT_REGISTRY_ENTRY_TYPE, agent);
	}
	for (const claim of registry.listClaims()) {
		pi.appendEntry(TASK_CLAIM_ENTRY_TYPE, claim);
	}
}

/**
 * Mirror of the parent↔child linkage scan run in supervision.ts `session_start`
 * (the handler is an inline closure, not exported). Kept byte-for-byte equivalent
 * to the production loop so this test locks the warn wire format.
 */
function runLinkageScan(registry: PersistentBgAgentRegistry): void {
	for (const agent of registry.listAgents()) {
		const parentId = registry.getParentSessionId(agent.id);
		if (parentId === null) continue; // orphan: no parent linkage recorded
		if (registry.getAgent(parentId)) {
			pandaWarn("subagent.linkage.parent-resolved", { childId: agent.id, parentId });
		} else {
			pandaWarn("subagent.linkage.parent-missing", { childId: agent.id });
		}
	}
}

/** Extract parsed `[panda-warn]` payloads matching a given code from a console.warn spy. */
function warnsWithCode(spy: ReturnType<typeof vi.spyOn>, code: string): Array<Record<string, unknown>> {
	return spy.mock.calls
		.filter((call) => typeof call[1] === "string" && (call[1] as string).includes(code))
		.map((call) => JSON.parse(call[1] as string) as Record<string, unknown>);
}

describe("subagent restart durability", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("scenario 1 — basic restart: bg-agent + task claim recover from the durable log", () => {
		const log = createSessionLog();

		// ---- Process 1: record a bg-agent and claim a task (write-through-first) ----
		const original = new PersistentBgAgentRegistry(log.pi);
		const agentEntry: BgAgentRegistryEntry = {
			id: "agent-restart-1",
			parentSessionId: "sess-parent-1",
			status: "running",
			claimedTaskIds: ["task-1"],
			lastSeenTs: 1000,
		};
		original.recordAgent(agentEntry);
		original.claimTask({ taskId: "task-1", sessionId: "sess-parent-1", ts: 1500 });

		// The durable appendEntry log now holds exactly the registry + claim row.
		expect(log.entries).toHaveLength(2);
		expect(log.entries[0]?.customType).toBe(BG_AGENT_REGISTRY_ENTRY_TYPE);
		expect(log.entries[1]?.customType).toBe(TASK_CLAIM_ENTRY_TYPE);

		// ---- Simulate SIGKILL: process-1 in-memory state is gone. A fresh registry
		// boots with empty caches; the only surviving state is the durable log. ----
		const rebooted = new PersistentBgAgentRegistry(log.pi);
		expect(rebooted.listAgents()).toHaveLength(0);
		expect(rebooted.listClaims()).toHaveLength(0);

		// ---- Restart: replay the durable log into the fresh registry ----
		const count = rebooted.replay(log.entries);

		expect(count).toBe(2);

		// bg-agent recovered with correct id/status/claimedTaskIds/parentSessionId.
		const recoveredAgent = rebooted.getAgent("agent-restart-1");
		expect(recoveredAgent).toEqual(agentEntry);
		expect(recoveredAgent?.id).toBe("agent-restart-1");
		expect(recoveredAgent?.status).toBe("running");
		expect(recoveredAgent?.claimedTaskIds).toEqual(["task-1"]);
		expect(recoveredAgent?.parentSessionId).toBe("sess-parent-1");

		// task claim recovered with correct taskId/sessionId.
		const recoveredClaim = rebooted.getClaim("task-1");
		expect(recoveredClaim).toEqual({ taskId: "task-1", sessionId: "sess-parent-1", ts: 1500 });
		expect(recoveredClaim?.taskId).toBe("task-1");
		expect(recoveredClaim?.sessionId).toBe("sess-parent-1");
	});

	it("scenario 2 — compaction then restart: only the post-compact baseline is replayed", () => {
		const log = createSessionLog();

		// ---- Pre-compact: populate the durable registry (write-through-first) ----
		const original = new PersistentBgAgentRegistry(log.pi);
		original.recordAgent({
			id: "agent-compact-a",
			parentSessionId: "sess-p",
			status: "running",
			claimedTaskIds: ["task-a"],
			lastSeenTs: 2000,
		});
		original.recordAgent({
			id: "agent-compact-b",
			parentSessionId: "sess-p",
			status: "completed",
			claimedTaskIds: [],
			lastSeenTs: 2500,
		});
		original.claimTask({ taskId: "task-a", sessionId: "sess-p", ts: 2100 });

		const preCompactAgents = original.listAgents();
		const preCompactClaims = original.listClaims();
		expect(preCompactAgents).toHaveLength(2);
		expect(preCompactClaims).toHaveLength(1);

		// ---- session_before_compact: an informational marker is written ----
		onBeforeCompact(log.pi, original);
		const marker = log.entries.find((e) => e.customType === "subagents:pre-compact-marker");
		expect(marker).toBeDefined();
		expect(marker?.data).toMatchObject({ registrySize: 2, claimsSize: 1 });

		// ---- Truncate the pre-compact portion of the log (compaction discards old rows) ----
		log.entries.length = 0;

		// ---- session_compact: re-emit live state as a fresh post-compact baseline ----
		onCompact(log.pi, original);

		// Only re-emitted baseline rows remain; the pre-compact marker is gone.
		expect(log.entries.filter((e) => e.customType === BG_AGENT_REGISTRY_ENTRY_TYPE)).toHaveLength(2);
		expect(log.entries.filter((e) => e.customType === TASK_CLAIM_ENTRY_TYPE)).toHaveLength(1);
		expect(log.entries.some((e) => e.customType === "subagents:pre-compact-marker")).toBe(false);

		// ---- Simulate SIGKILL + restart: a fresh registry replays ONLY the truncated
		// (post-compact) log — the pre-compact entries are no longer available. ----
		const rebooted = new PersistentBgAgentRegistry(log.pi);
		const count = rebooted.replay(log.entries);

		expect(count).toBe(3);
		expect(rebooted.listAgents()).toHaveLength(2);
		expect(rebooted.listClaims()).toHaveLength(1);
		expect([...rebooted.listAgents()].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
			[...preCompactAgents].sort((a, b) => a.id.localeCompare(b.id)),
		);
		expect([...rebooted.listClaims()].sort((a, b) => a.taskId.localeCompare(b.taskId))).toEqual(
			[...preCompactClaims].sort((a, b) => a.taskId.localeCompare(b.taskId)),
		);
		expect(rebooted.getAgent("agent-compact-a")?.parentSessionId).toBe("sess-p");
	});

	it("scenario 3 — parent resolution survives restart and re-emits parent-resolved", () => {
		const log = createSessionLog();

		// ---- Process 1: a parent agent and a child whose parentSessionId points at it ----
		const original = new PersistentBgAgentRegistry(log.pi);
		const written: BgAgentRegistryEntry[] = [
			{ id: "parent-agent", status: "running", claimedTaskIds: [], lastSeenTs: 100 },
			{ id: "child-agent", parentSessionId: "parent-agent", status: "running", claimedTaskIds: [], lastSeenTs: 200 },
		];
		for (const entry of written) original.recordAgent(entry);

		// ---- Simulate SIGKILL + restart: fresh registry replays the durable log ----
		const rebooted = new PersistentBgAgentRegistry(log.pi);
		rebooted.replay(log.entries);

		// Parent linkage recovered post-restart.
		expect(rebooted.getParentSessionId("child-agent")).toBe("parent-agent");
		expect(rebooted.getParentSessionId("parent-agent")).toBeNull();

		// ---- session_start linkage scan: emits parent-resolved with childId/parentId ----
		warnSpy.mockClear();
		runLinkageScan(rebooted);

		const resolved = warnsWithCode(warnSpy, "subagent.linkage.parent-resolved");
		expect(resolved).toHaveLength(1);
		expect(resolved[0]).toMatchObject({
			code: "subagent.linkage.parent-resolved",
			childId: "child-agent",
			parentId: "parent-agent",
		});
		expect(warnsWithCode(warnSpy, "subagent.linkage.parent-missing")).toHaveLength(0);
	});
});
