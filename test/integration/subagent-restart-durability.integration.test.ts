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
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pandaWarn } from "../../extensions/lib/warn.js";
import { reconcileDurableRunningTargets } from "../../extensions/subagent/src/lifecycle/running-reconciliation.js";
import { lifecycleSnapshotInput } from "../../extensions/subagent/src/lifecycle/agent-lifecycle-store.js";
import { AgentRun } from "../../extensions/subagent/src/agent-run.js";
import {
	BG_AGENT_REGISTRY_ENTRY_TYPE,
	type BgAgentRegistryEntry,
	PersistentBgAgentRegistry,
	RESUME_TARGET_ENTRY_TYPE,
	TASK_CLAIM_ENTRY_TYPE,
} from "../../extensions/subagent/src/lifecycle/registry-persistence.js";
import type { AgentRecord, ResumeTargetV1 } from "../../extensions/subagent/src/types.js";

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

const RECOVERY_HASH = "a".repeat(64);

function recoveryRuntime(): ResumeTargetV1["runtime"] {
	return {
		piVersion: "test",
		model: { provider: "faux", id: "model", api: "messages" },
		thinkingLevel: "off",
		promptMode: "replace",
		isolated: false,
		inheritContext: false,
		systemPromptHash: RECOVERY_HASH,
		resourcePolicyHash: RECOVERY_HASH,
		agentConfigHash: RECOVERY_HASH,
		extensionIdentities: [],
		activeToolNames: [],
	};
}

function recoveryFixture(suffix: readonly Record<string, unknown>[]) {
	const root = mkdtempSync(join(tmpdir(), "subagent-running-recovery-"));
	const file = join(root, "child.jsonl");
	const header = { type: "session", version: 3, id: "child-recovery", timestamp: "2026-01-01T00:00:00Z", cwd: root };
	const boundary = { type: "custom", id: "leaf", parentId: null, timestamp: "2026-01-01T00:00:01Z", customType: "agent-mode", data: {} };
	const prefix = `${JSON.stringify(header)}\n${JSON.stringify(boundary)}\n`;
	const bytes = `${prefix}${suffix.map((row) => JSON.stringify(row)).join("\n")}${suffix.length > 0 ? "\n" : ""}`;
	writeFileSync(file, bytes);
	const target: ResumeTargetV1 = {
		version: 1, id: "agent-recovery", generation: 4, revision: 2, parentSessionId: "parent-recovery",
		sessionFile: file, sessionDir: root, childSessionId: "child-recovery", entryCount: 1, activeLeafId: "leaf",
		sessionSha256: createHash("sha256").update(prefix).digest("hex"), type: "jintong", description: "recover interrupted generation",
		cwd: root, isBackground: true, createdAt: 1, updatedAt: 2, runtime: recoveryRuntime(),
		state: { status: "running", completionDisposition: "clean", resultConsumed: false, notified: false, toolUses: 0,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, lifetimeCost: 0, compactionCount: 0 },
	};
	return { root, file, target };
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

describe("durable running-generation restart reconciliation", () => {
	it("repairs a clean terminal suffix without provider, tool, or lifecycle replay", async () => {
		const fixture = recoveryFixture([{
			type: "message", id: "final", parentId: "leaf", timestamp: "2026-01-01T00:00:02Z",
			message: { role: "assistant", content: [{ type: "text", text: "preserved crash result" }], stopReason: "stop" },
		}]);
		const log = createSessionLog();
		log.entries.push({ type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: fixture.target });
		const registry = new PersistentBgAgentRegistry(log.pi);
		registry.replay(log.entries);
		const provider = vi.fn();
		const tool = vi.fn();
		const events = { emit: vi.fn() };

		const outcomes = await reconcileDurableRunningTargets({
			registry, parentSessionId: "parent-recovery", getRecord: () => undefined,
			pi: { appendEntry: log.pi.appendEntry, events }, now: () => 10,
		});

		expect(outcomes).toEqual([{ id: "agent-recovery", status: "recovered", classification: "clean_final_assistant" }]);
		expect(registry.getResumeTarget("agent-recovery")).toMatchObject({
			generation: 4, revision: 3, entryCount: 2, activeLeafId: "final",
			sessionSha256: createHash("sha256").update(readFileSync(fixture.file)).digest("hex"),
			state: { status: "completed" },
		});
		expect(log.entries.at(-1)).toMatchObject({
			customType: "subagents:record", data: { id: "agent-recovery", status: "completed", result: "preserved crash result" },
		});
		expect(provider).not.toHaveBeenCalled();
		expect(tool).not.toHaveBeenCalled();
		expect(events.emit).not.toHaveBeenCalled();
		rmSync(fixture.root, { recursive: true, force: true });
	});

	it.each(["boundary-before-final", "final-leaf"] as const)(
		"repairs recovered historical errors at %s without replaying historical tools",
		async (snapshotBoundary) => {
			const fixture = recoveryFixture([
				{ type: "message", id: "interrupted", parentId: "leaf", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "toolCall", id: "historical-call", name: "write", arguments: {} }], stopReason: "error" } },
				{ type: "message", id: "boundary", parentId: "interrupted", timestamp: "2026-01-01T00:00:03Z", message: { role: "user", content: "recover explicitly" } },
				{ type: "message", id: "final", parentId: "boundary", timestamp: "2026-01-01T00:00:04Z", message: { role: "assistant", content: [{ type: "text", text: "recovered durable result" }], stopReason: "stop" } },
			]);
			if (snapshotBoundary === "final-leaf") {
				fixture.target.entryCount = 4;
				fixture.target.activeLeafId = "final";
				fixture.target.sessionSha256 = createHash("sha256").update(readFileSync(fixture.file)).digest("hex");
				writeFileSync(fixture.file, `${readFileSync(fixture.file, "utf8")}${JSON.stringify({
					type: "session_info", id: "title", parentId: "final", timestamp: "2026-01-01T00:00:05Z", name: "Late recovered title",
				})}\n`);
			}
			const log = createSessionLog();
			log.entries.push({ type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: fixture.target });
			const registry = new PersistentBgAgentRegistry(log.pi);
			registry.replay(log.entries);
			const provider = vi.fn();
			const historicalTool = vi.fn();

			const outcomes = await reconcileDurableRunningTargets({
				registry, parentSessionId: "parent-recovery", getRecord: () => undefined,
				pi: { appendEntry: log.pi.appendEntry, events: { emit: vi.fn() } }, now: () => 10,
			});

			expect(outcomes).toEqual([{ id: "agent-recovery", status: "recovered", classification: "clean_final_assistant" }]);
			expect(registry.getResumeTarget("agent-recovery")).toMatchObject({
				...(snapshotBoundary === "final-leaf" ? { entryCount: 5, activeLeafId: "title" } : {}),
				state: { status: "completed", completionDisposition: "recovered" },
			});
			expect(log.entries.at(-1)).toMatchObject({
				customType: "subagents:record", data: { status: "completed", result: "recovered durable result" },
			});
			expect(provider).not.toHaveBeenCalled();
			expect(historicalTool).not.toHaveBeenCalled();
			rmSync(fixture.root, { recursive: true, force: true });
		},
	);

	it("rejects a pending terminal candidate whose result does not exactly match authenticated final text", async () => {
		const fixture = recoveryFixture([{
			type: "message", id: "final", parentId: "leaf", timestamp: "2026-01-01T00:00:02Z",
			message: { role: "assistant", content: [{ type: "text", text: "authenticated result" }], stopReason: "stop" },
		}]);
		const log = createSessionLog();
		log.entries.push({ type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: fixture.target });
		const registry = new PersistentBgAgentRegistry(log.pi);
		registry.replay(log.entries);
		const run = new AgentRun(fixture.target.id);
		run.failTerminalCommit({ kind: "completed", status: "completed", result: "different result" }, new Error("append failed"));
		const record: AgentRecord = {
			id: fixture.target.id, type: fixture.target.type, description: fixture.target.description,
			status: "error", toolUses: 0, startedAt: 1, run,
		};

		const outcomes = await reconcileDurableRunningTargets({
			registry, parentSessionId: "parent-recovery", getRecord: () => record,
			pi: { appendEntry: log.pi.appendEntry, events: { emit: vi.fn() } }, now: () => 10,
		});

		expect(outcomes).toEqual([{ id: "agent-recovery", status: "rejected", reason: "session_corrupt_or_unsupported" }]);
		expect(registry.getResumeTarget("agent-recovery")).toEqual(expect.objectContaining({ generation: 4, revision: 2 }));
		expect(run.pendingTerminal).toBeDefined();
		rmSync(fixture.root, { recursive: true, force: true });
	});

	it.each([
		["no suffix", []],
		["metadata only", [{ type: "session_info", id: "meta", parentId: "leaf", timestamp: "2026-01-01T00:00:02Z", name: "late title" }]],
		["user only", [{ type: "message", id: "user", parentId: "leaf", timestamp: "2026-01-01T00:00:02Z", message: { role: "user", content: "continue" } }]],
		["pending tool", [{ type: "message", id: "tool", parentId: "leaf", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "write", arguments: {} }], stopReason: "toolUse" } }]],
	] as const)("persists conservative failure for %s without replay", async (_name, suffix) => {
		const fixture = recoveryFixture(suffix);
		const log = createSessionLog();
		log.entries.push({ type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: fixture.target });
		const registry = new PersistentBgAgentRegistry(log.pi);
		registry.replay(log.entries);
		const provider = vi.fn();
		const tool = vi.fn();
		const events = { emit: vi.fn() };

		const [outcome] = await reconcileDurableRunningTargets({
			registry, parentSessionId: "parent-recovery", getRecord: () => undefined,
			pi: { appendEntry: log.pi.appendEntry, events }, now: () => 10,
		});

		expect(outcome).toMatchObject({ id: "agent-recovery", status: "failed", reason: "unsafe_interrupted_operation" });
		expect(registry.getResumeTarget("agent-recovery")).toMatchObject({ generation: 4, revision: 3, state: { status: "error" } });
		expect(log.entries.at(-1)).toMatchObject({
			customType: "subagents:record", data: { status: "error", error: expect.stringContaining("unsafe_interrupted_operation") },
		});
		expect(provider).not.toHaveBeenCalled();
		expect(tool).not.toHaveBeenCalled();
		expect(events.emit).not.toHaveBeenCalled();
		rmSync(fixture.root, { recursive: true, force: true });
	});

	it("leaves corrupt state at the last valid V1 row and invalidates stale callbacks after repair", async () => {
		const clean = recoveryFixture([{
			type: "message", id: "final", parentId: "leaf", timestamp: "2026-01-01T00:00:02Z",
			message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		}]);
		const log = createSessionLog();
		const registry = new PersistentBgAgentRegistry(log.pi);
		const initialized = await registry.getOrCreateLifecycleStore(clean.target.id).initialize(lifecycleSnapshotInput({ ...clean.target, generation: 0, revision: 0 }));
		const running = registry.getResumeTarget(clean.target.id)!;
		log.entries.length = 0;
		log.entries.push({ type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: running });
		registry.replay(log.entries);

		await reconcileDurableRunningTargets({
			registry, parentSessionId: "parent-recovery", getRecord: () => undefined,
			pi: { appendEntry: log.pi.appendEntry, events: { emit: vi.fn() } }, now: () => 10,
		});
		await expect(registry.getLifecycleStore(clean.target.id)!.checkpoint(initialized.lease, {
			...lifecycleSnapshotInput(running), updatedAt: 11,
		})).rejects.toThrow("lifecycle lease");

		const corrupt = recoveryFixture([]);
		writeFileSync(corrupt.file, readFileSync(corrupt.file, "utf8").replace("agent-mode", "tampered-mode"));
		const corruptLog = createSessionLog();
		corruptLog.entries.push({ type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: corrupt.target });
		const rebooted = new PersistentBgAgentRegistry(corruptLog.pi);
		rebooted.replay(corruptLog.entries);
		const outcomes = await reconcileDurableRunningTargets({
			registry: rebooted, parentSessionId: "parent-recovery", getRecord: () => undefined,
			pi: { appendEntry: corruptLog.pi.appendEntry, events: { emit: vi.fn() } }, now: () => 10,
		});

		expect(outcomes).toEqual([{ id: "agent-recovery", status: "rejected", reason: "session_corrupt_or_unsupported" }]);
		expect(rebooted.getResumeTarget("agent-recovery")).toEqual(corrupt.target);
		expect(corruptLog.entries).toHaveLength(1);

		const malformed = recoveryFixture([{
			type: "message", id: "bad", parentId: "leaf", timestamp: "2026-01-01T00:00:02Z",
			message: { role: "assistant", content: "not-an-array", stopReason: "stop" },
		}]);
		const malformedLog = createSessionLog();
		malformedLog.entries.push({ type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: malformed.target });
		const malformedRegistry = new PersistentBgAgentRegistry(malformedLog.pi);
		malformedRegistry.replay(malformedLog.entries);
		await expect(reconcileDurableRunningTargets({
			registry: malformedRegistry, parentSessionId: "parent-recovery", getRecord: () => undefined,
			pi: { appendEntry: malformedLog.pi.appendEntry, events: { emit: vi.fn() } }, now: () => 10,
		})).resolves.toEqual([{ id: "agent-recovery", status: "rejected", reason: "session_corrupt_or_unsupported" }]);
		expect(malformedRegistry.getResumeTarget("agent-recovery")).toEqual(malformed.target);
		expect(malformedLog.entries).toHaveLength(1);
		rmSync(clean.root, { recursive: true, force: true });
		rmSync(corrupt.root, { recursive: true, force: true });
		rmSync(malformed.root, { recursive: true, force: true });
	});
});
});
