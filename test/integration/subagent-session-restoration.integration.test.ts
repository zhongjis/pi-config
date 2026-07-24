import { afterEach, describe, expect, it } from "vitest";
import {
	calls,
	createTestSession,
	says,
	when,
	type TestSession,
} from "@marcfargas/pi-test-harness";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { stableSha256 } from "../../extensions/subagent/src/session-restoration.js";
import type { ResumeTargetV1 } from "../../extensions/subagent/src/types.js";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const SUBAGENT_SOURCE = path.join(PROJECT_ROOT, "extensions/subagent/index.ts");
const AGENT_TYPE = "restoration-probe";
const FAUX_API = "subagent-restoration-native-faux-api";
const FAUX_PROVIDER = "subagent-restoration-native-faux";
const FAUX_MODEL_ID = "restoration-faux-1";
const FAUX_HANDLE_SYMBOL = Symbol.for("pi-subagent-restoration-test:faux-handle");

interface NativeFauxHandle {
	contexts: string[];
	appendResponse(text: string): void;
	appendControlledResponse(text: string): { started: Promise<void>; release(): void };
	waitForCompaction(): Promise<{ id: string; compactionCount: number }>;
	failNextTerminalCommit(): void;
	pendingResponses(): number;
	callCount(): number;
	unregister(): void;
}

interface SessionLike {
	extensionRunner?: {
		hasHandlers(event: "session_shutdown" | "session_start"): boolean;
		emit(event: { type: "session_shutdown" } | { type: "session_start"; reason: "new" }): Promise<void> | void;
	};
	agent?: { state?: { tools?: Array<{ name: string }> } };
	modelRegistry: { find(provider: string, modelId: string): Model<any> | undefined };
	setModel(model: Model<any>): Promise<void>;
	thinkingLevel?: ResumeTargetV1["runtime"]["thinkingLevel"];
	abort?: () => void;
	dispose?: () => void;
	sessionManager?: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> };
	_emit?(event: { type: "compaction_end"; reason: "context_length"; result: { tokensBefore: number }; aborted: false }): void;
}

interface AgentRecordLike {
	id: string;
	session?: SessionLike;
	sessionFile?: string;
	status?: string;
	completionDisposition?: "clean" | "recovered";
	error?: string;
	result?: string;
	toolUses?: number;
	promise?: Promise<unknown>;
}

interface AgentInvocationDetails {
	agentId?: string;
	invocationStatus?: "started_new" | "resumed_live" | "restored_session" | "failed";
	failureReason?: string;
}

interface AgentToolResultRecord {
	text: string;
	details?: unknown;
	isError: boolean;
}

interface SubagentManagerLike {
	getRecord(id: string): AgentRecordLike | undefined;
}

let t: TestSession | undefined;
let fixtureRoot = "";
let previousAgentDir: string | undefined;
let manager: SubagentManagerLike | undefined;
const spawnedIds = new Set<string>();

function nativeFauxHandle(): NativeFauxHandle {
	const handle = (globalThis as Record<PropertyKey, unknown>)[FAUX_HANDLE_SYMBOL];
	if (!handle || typeof handle !== "object" || typeof (handle as NativeFauxHandle).appendResponse !== "function") {
		throw new Error("Native faux wrapper handle was not registered");
	}
	return handle as NativeFauxHandle;
}

function getManager(): SubagentManagerLike {
	const candidate = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-subagents:manager")];
	if (!candidate || typeof candidate !== "object" || typeof (candidate as SubagentManagerLike).getRecord !== "function") {
		throw new Error("Subagent manager was not registered");
	}
	return candidate as SubagentManagerLike;
}

function persistedResumeTargets(id: string): ResumeTargetV1[] {
	const session = t?.session as SessionLike | undefined;
	return (session?.sessionManager?.getEntries() ?? [])
		.filter((entry) => entry.type === "custom" && entry.customType === "subagents:resume-target-v1")
		.map((entry) => entry.data as ResumeTargetV1)
		.filter((target) => target.id === id);
}

function installFixture(): { cwd: string; wrapperPath: string } {
	fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-subagent-restoration-"));
	const cwd = path.join(fixtureRoot, "project");
	const agentDir = path.join(fixtureRoot, "agent-dir");
	const wrapperDir = path.join(fixtureRoot, "extensions");
	const wrapperPath = path.join(wrapperDir, "subagent-native-faux.ts");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
	mkdirSync(wrapperDir, { recursive: true });
	writeFileSync(
		path.join(agentDir, "agents", `${AGENT_TYPE}.md`),
		`---
description: Deterministic session restoration probe
prompt_mode: replace
builtin_tools: read
extensions: true
---

Answer only from this conversation.
`,
	);
	writeFileSync(
		path.join(agentDir, "extensions", "bind-mode.ts"),
		`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function(pi: ExtensionAPI) {
  pi.on("session_start", () => {
    pi.appendEntry("agent-mode", { mode: "restoration-probe", delegationPolicy: { version: 1, allowDelegationTo: [], disallowDelegationTo: [] } });
  });
}
		`,
	);

	let subagentImport = path.relative(wrapperDir, SUBAGENT_SOURCE).split(path.sep).join("/");
	if (!subagentImport.startsWith(".")) subagentImport = `./${subagentImport}`;
	writeFileSync(
		wrapperPath,
		`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import subagentFactory from ${JSON.stringify(subagentImport)};

const API = ${JSON.stringify(FAUX_API)};
const PROVIDER = ${JSON.stringify(FAUX_PROVIDER)};
const MODEL_ID = ${JSON.stringify(FAUX_MODEL_ID)};
const HANDLE = Symbol.for("pi-subagent-restoration-test:faux-handle");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTerminalTarget(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.state)) return false;
  return ["completed", "steered", "aborted", "stopped", "error"].includes(String(value.state.status));
}

export default function(pi: ExtensionAPI) {
  let failTerminalCommit = false;
  const originalAppendEntry = pi.appendEntry.bind(pi);
  pi.appendEntry = (customType: string, data?: unknown) => {
    if (failTerminalCommit && customType === "subagents:resume-target-v1" && isTerminalTarget(data)) {
      failTerminalCommit = false;
      throw new Error("injected terminal append fault");
    }
    return originalAppendEntry(customType, data);
  };

  const faux = registerFauxProvider({
    api: API,
    provider: PROVIDER,
    models: [{ id: MODEL_ID, name: "Session Restoration Faux" }],
  });
  pi.registerProvider(PROVIDER, {
    api: API,
    apiKey: "test-key",
    baseUrl: "http://localhost:0",
    models: [{
      id: MODEL_ID,
      name: "Session Restoration Faux",
      api: API,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    }],
  });

  const compactions: Array<{ id: string; compactionCount: number }> = [];
  const compactionWaiters: Array<(event: { id: string; compactionCount: number }) => void> = [];
  let unsubCompacted = () => {};
  const handle = {
    contexts: [] as string[],
    appendResponse(text: string) {
      faux.appendResponses([(context) => {
        handle.contexts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(text);
      }]);
    },
    appendControlledResponse(text: string) {
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      faux.appendResponses([async (context) => {
        handle.contexts.push(JSON.stringify(context.messages));
        markStarted();
        await released;
        return fauxAssistantMessage(text);
      }]);
      return { started, release };
    },
    waitForCompaction() {
      const queued = compactions.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<{ id: string; compactionCount: number }>((resolve) => { compactionWaiters.push(resolve); });
    },
    failNextTerminalCommit() { failTerminalCommit = true; },
    pendingResponses: () => faux.getPendingResponseCount(),
    callCount: () => faux.state.callCount,
    unregister() { unsubCompacted(); faux.unregister(); },
  };
  (globalThis as Record<PropertyKey, unknown>)[HANDLE] = handle;
  unsubCompacted = pi.events.on("subagents:compacted", (data: unknown) => {
    if (!isRecord(data) || typeof data.id !== "string" || typeof data.compactionCount !== "number") return;
    const event = { id: data.id, compactionCount: data.compactionCount };
    const waiter = compactionWaiters.shift();
    if (waiter) waiter(event);
    else compactions.push(event);
  });
  subagentFactory(pi);
}
`,
	);

	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return { cwd, wrapperPath };
}

async function createIsolatedSession(): Promise<SessionLike> {
	const { cwd, wrapperPath } = installFixture();
	t = await createTestSession({ cwd, extensions: [wrapperPath], propagateErrors: false });
	const session = t.session as SessionLike;
	const parentTools = session.agent?.state?.tools?.map((tool) => tool.name) ?? [];
	expect(parentTools).toContain("Agent");
	manager = getManager();
	const selected = session.modelRegistry.find(FAUX_PROVIDER, FAUX_MODEL_ID);
	if (!selected) throw new Error("Native faux model missing from parent modelRegistry");
	await session.setModel(selected);
	return session;
}

function agentParams(prompt: string, resume?: string): Record<string, unknown> {
	return {
		prompt,
		description: "characterize persisted child context",
		subagent_type: AGENT_TYPE,
		model: `${FAUX_PROVIDER}/${FAUX_MODEL_ID}`,
		...(resume ? { resume } : {}),
	};
}

async function invokeAgent(parentPrompt: string, params: Record<string, unknown>): Promise<AgentToolResultRecord> {
	if (!t) throw new Error("Parent session was not created");
	await t.run(when(parentPrompt, [calls("Agent", params), says("Parent acknowledged.")]));
	const result = t.events.toolResultsFor("Agent").at(-1);
	if (!result) throw new Error("Registered Agent tool produced no result");
	return result;
}

function invocationDetails(result: AgentToolResultRecord): AgentInvocationDetails {
	if (!result.details || typeof result.details !== "object") throw new Error("Agent result omitted typed details");
	return result.details as AgentInvocationDetails;
}

function agentIdFrom(result: AgentToolResultRecord): string {
	const id = invocationDetails(result).agentId;
	if (!id) throw new Error("Agent result omitted typed agentId");
	spawnedIds.add(id);
	return id;
}

function sessionFileFor(id: string): string {
	const sessionFile = manager?.getRecord(id)?.sessionFile;
	if (!sessionFile) throw new Error("Agent record omitted sessionFile");
	return sessionFile;
}

function appendLateTitle(sessionFile: string): void {
	const rows = readFileSync(sessionFile, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
	const parentId = rows.at(-1)?.id;
	if (typeof parentId !== "string") throw new Error("Child session has no leaf for title metadata");
	writeFileSync(sessionFile, `${readFileSync(sessionFile, "utf8")}${JSON.stringify({
		type: "session_info", id: `late-title-${Date.now()}`, parentId,
		timestamp: new Date().toISOString(), name: "Restoration probe complete",
	})}\n`);
}

function appendRecoveredHistory(sessionFile: string): void {
  const rows = readFileSync(sessionFile, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  const parentId = rows.at(-1)?.id;
  if (typeof parentId !== "string") throw new Error("Child session has no leaf for recovered history");
  const now = Date.now();
  const assistantMetadata = {
    api: FAUX_API, provider: FAUX_PROVIDER, model: FAUX_MODEL_ID,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const recoveredRows = [
    {
      type: "message", id: `historical-error-${now}`, parentId, timestamp: new Date(now).toISOString(),
      message: {
        role: "assistant", content: [{ type: "toolCall", id: "historical-call-never-run", name: "read", arguments: { path: "never-read" } }],
        ...assistantMetadata, stopReason: "error", errorMessage: "historical provider failure", timestamp: now,
      },
    },
    {
      type: "message", id: `recovery-boundary-${now}`, parentId: `historical-error-${now}`, timestamp: new Date(now + 1).toISOString(),
      message: { role: "user", content: "Explicitly recover after the failed turn.", timestamp: now + 1 },
    },
    {
      type: "message", id: `recovered-final-${now}`, parentId: `recovery-boundary-${now}`, timestamp: new Date(now + 2).toISOString(),
      message: { ...assistantMetadata, role: "assistant", content: [{ type: "text", text: "Authenticated recovered history result." }], stopReason: "stop", timestamp: now + 2 },
    },
  ];
  writeFileSync(sessionFile, `${readFileSync(sessionFile, "utf8")}${recoveredRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function emitSuccessfulChildCompaction(id: string): void {
	const child = manager?.getRecord(id)?.session;
	if (!child?._emit) throw new Error("Real child session omitted its event emitter");
	child._emit({
		type: "compaction_end",
		reason: "context_length",
		result: { tokensBefore: 4_096 },
		aborted: false,
	});
}

async function emitProductionSessionStart(session: SessionLike): Promise<void> {
	const runner = session.extensionRunner;
	if (!runner?.hasHandlers("session_start")) throw new Error("subagent session_start handler was not registered");
	await runner.emit({ type: "session_start", reason: "new" });
}

async function shutdownSession(session: SessionLike | undefined): Promise<void> {
	try {
		if (session?.extensionRunner?.hasHandlers("session_shutdown")) {
			await session.extensionRunner.emit({ type: "session_shutdown" });
		}
	} catch (error) { void error; }
	try { session?.abort?.(); } catch (error) { void error; }
	try { session?.dispose?.(); } catch (error) { void error; }
}

async function cleanupFixture(): Promise<void> {
	for (const id of spawnedIds) {
		const record = manager?.getRecord(id);
		await shutdownSession(record?.session);
		if (record?.promise) await Promise.race([record.promise.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1_000))]);
	}
	spawnedIds.clear();
	const handle = (globalThis as Record<PropertyKey, unknown>)[FAUX_HANDLE_SYMBOL] as NativeFauxHandle | undefined;
	try { handle?.unregister(); } catch (error) { void error; }
	delete (globalThis as Record<PropertyKey, unknown>)[FAUX_HANDLE_SYMBOL];
	await shutdownSession(t?.session as SessionLike | undefined);
	t?.dispose();
	t = undefined;
	manager = undefined;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	previousAgentDir = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = "";
}

describe.sequential("subagent session restoration — integration", () => {
	afterEach(cleanupFixture);

	it("live resume keeps the same child session and prior context", async () => {
		await createIsolatedSession();
		const faux = nativeFauxHandle();
		const firstPrompt = "Remember sentinel RESTORE-CONTEXT-17.";
		faux.appendResponse("Stored RESTORE-CONTEXT-17.");
		const firstResult = await invokeAgent("Start live restoration probe", agentParams(firstPrompt));
		const id = agentIdFrom(firstResult);
		const sessionFile = sessionFileFor(id);
		const originalRecord = manager!.getRecord(id);
		const originalSession = originalRecord?.session;
		expect(originalRecord?.status).toBe("completed");
		expect(originalSession).toBeDefined();
		const initialTarget = persistedResumeTargets(id).at(-1)!;
		expect(originalSession?.thinkingLevel).toBeDefined();
		expect(initialTarget.runtime.thinkingLevel).toBe(originalSession?.thinkingLevel);

		const followUp = "Repeat the sentinel from the prior turn.";
		faux.appendResponse("RESTORE-CONTEXT-17");
		const resumedResult = await invokeAgent("Resume live restoration probe", agentParams(followUp, id));
		const resumedRecord = manager!.getRecord(id);

		expect(resumedResult.text).toContain("RESTORE-CONTEXT-17");
		expect(invocationDetails(resumedResult)).toMatchObject({ agentId: id, invocationStatus: "resumed_live" });
		expect(resumedRecord).toBe(originalRecord);
		expect(resumedRecord?.session).toBe(originalSession);
		expect(resumedRecord?.sessionFile).toBe(sessionFile);
		expect(faux.callCount()).toBe(2);
		expect(faux.pendingResponses()).toBe(0);
		expect(faux.contexts).toHaveLength(2);
		expect(faux.contexts[1]).toContain(firstPrompt);
		expect(faux.contexts[1]).toContain(followUp);
		const persisted = readFileSync(sessionFile, "utf8");
		expect(persisted).toContain(firstPrompt);
		expect(persisted).toContain(followUp);
		const liveRows = persisted.trimEnd().split("\n").map((line) => JSON.parse(line));
		const liveGeneration = persistedResumeTargets(id).filter((target) => target.generation === initialTarget.generation + 1);
		expect(liveGeneration.map((target) => [target.revision, target.state.status])).toEqual([
			[0, "running"],
			[1, "completed"],
		]);
		const liveTarget = liveGeneration.at(-1)!;
		expect(liveTarget).toMatchObject({
			entryCount: liveRows.length - 1,
			activeLeafId: liveRows.at(-1)?.id,
			sessionSha256: stableSha256(readFileSync(sessionFile)),
			state: { status: "completed" },
		});

		await emitProductionSessionStart(t!.session as SessionLike);
		expect(manager!.getRecord(id)).toBeUndefined();
		const restoredPrompt = "Repeat the sentinel after live cleanup.";
		faux.appendResponse("RESTORE-CONTEXT-17 restored after live cleanup");
		const restoredResult = await invokeAgent("Restore after live resume", agentParams(restoredPrompt, id));
		expect(restoredResult.isError).toBe(false);
		expect(invocationDetails(restoredResult)).toMatchObject({ agentId: id, invocationStatus: "restored_session" });
		expect(readFileSync(sessionFile, "utf8")).toContain(restoredPrompt);
	});

	it("restores a completed child after production session-start cleanup", async () => {
		const session = await createIsolatedSession();
		const faux = nativeFauxHandle();
		const firstPrompt = "Remember stale sentinel RESTORE-CONTEXT-17.";
		faux.appendResponse("Stored stale RESTORE-CONTEXT-17.");
		const firstResult = await invokeAgent("Start stale restoration probe", agentParams(firstPrompt));
		const id = agentIdFrom(firstResult);
		const sessionFile = sessionFileFor(id);
		const childDir = path.dirname(sessionFile);
		const filesBefore = readdirSync(childDir).sort();

		appendLateTitle(sessionFile);
		await emitProductionSessionStart(session);
		expect(manager!.getRecord(id)).toBeUndefined();
		const followUp = "Repeat the stale sentinel after cleanup.";
		faux.appendResponse("RESTORE-CONTEXT-17 restored");
		const staleResult = await invokeAgent("Resume stale restoration probe", agentParams(followUp, id));
		expect(readdirSync(childDir).sort()).toEqual(filesBefore);
		expect(staleResult.isError).toBe(false);
		expect(invocationDetails(staleResult)).toMatchObject({ agentId: id, invocationStatus: "restored_session" });
		expect(manager!.getRecord(id)?.sessionFile).toBe(sessionFile);
		expect(faux.contexts).toHaveLength(2);
		expect(faux.contexts[1]).toContain(firstPrompt);
		expect(faux.contexts[1]).toContain(followUp);
		const restoredRows = readFileSync(sessionFile, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
		expect(restoredRows.filter((row) => row.type === "session_info")).toHaveLength(1);
		expect(restoredRows.filter((row) => row.type === "custom" && row.customType === "agent-mode").length).toBeGreaterThanOrEqual(2);
		const acceptedRestoredTargets = persistedResumeTargets(id).slice(-2);
		expect(acceptedRestoredTargets).toHaveLength(2);
		expect(acceptedRestoredTargets[1]).toMatchObject({
			generation: acceptedRestoredTargets[0]!.generation,
			revision: acceptedRestoredTargets[0]!.revision + 1,
			entryCount: restoredRows.length - 1,
			activeLeafId: restoredRows.at(-1)?.id,
			sessionSha256: stableSha256(readFileSync(sessionFile)),
			state: { status: "completed" },
		});

		await emitProductionSessionStart(session);
		expect(manager!.getRecord(id)).toBeUndefined();
		const secondRestoredPrompt = "Repeat the stale sentinel after another cleanup.";
		faux.appendResponse("RESTORE-CONTEXT-17 restored twice");
		const secondRestoredResult = await invokeAgent(
			"Resume restored probe again",
			agentParams(secondRestoredPrompt, id),
		);
		expect(secondRestoredResult.isError).toBe(false);
		expect(invocationDetails(secondRestoredResult)).toMatchObject({ agentId: id, invocationStatus: "restored_session" });
		expect(readFileSync(sessionFile, "utf8")).toContain(secondRestoredPrompt);
	});

	it("restores recovered history as context and resumes only through a fresh prompt", async () => {
		const session = await createIsolatedSession();
		const faux = nativeFauxHandle();
		faux.appendResponse("Original clean result.");
		const firstResult = await invokeAgent("Start recovered-history probe", agentParams("Create a clean durable target."));
		const id = agentIdFrom(firstResult);
		const sessionFile = sessionFileFor(id);
		const originalTarget = persistedResumeTargets(id).at(-1)!;
		expect(originalTarget.state.completionDisposition).toBe("clean");

		appendRecoveredHistory(sessionFile);
		await emitProductionSessionStart(session);
		expect(manager!.getRecord(id)).toBeUndefined();
		faux.appendResponse("Fresh prompt resumed recovered context.");
		const freshPrompt = "Continue recovered session through this fresh prompt only.";
		const resumed = await invokeAgent("Resume recovered-history probe", agentParams(freshPrompt, id));

		expect(resumed.isError).toBe(false);
		expect(invocationDetails(resumed)).toMatchObject({ agentId: id, invocationStatus: "restored_session" });
		expect(manager!.getRecord(id)?.status).toBe("completed");
		expect(manager!.getRecord(id)?.completionDisposition).toBe("recovered");
		expect(manager!.getRecord(id)?.toolUses).toBe(0);
		expect(faux.callCount()).toBe(2);
		expect(faux.contexts.at(-1)).toContain(freshPrompt);
		expect(faux.contexts.at(-1)).toContain("Authenticated recovered history result.");
		expect(persistedResumeTargets(id).at(-1)).toMatchObject({
			state: { status: "completed", completionDisposition: "recovered" },
		});
	});

	it("orders a restored resume compaction checkpoint before terminal durability without duplicate execution", async () => {
		const session = await createIsolatedSession();
		const faux = nativeFauxHandle();
		faux.appendResponse("Original completed result.");
		const firstResult = await invokeAgent("Start durable race probe", agentParams("Create the original durable target."));
		const id = agentIdFrom(firstResult);
		const sessionFile = sessionFileFor(id);
		const originalTarget = persistedResumeTargets(id).at(-1)!;

		await emitProductionSessionStart(session);
		expect(manager!.getRecord(id)).toBeUndefined();

		const controlled = faux.appendControlledResponse("Fresh restored result RACE-RESULT-83.");
		const resumedPromise = invokeAgent(
			"Resume durable race probe",
			agentParams("Complete the restored race exactly once.", id),
		);
		await controlled.started;

		const runningTarget = persistedResumeTargets(id).at(-1)!;
		expect(runningTarget).toMatchObject({
			generation: originalTarget.generation + 1,
			revision: 0,
			state: { status: "running", resultConsumed: false, notified: false },
		});

		const compactedEvent = faux.waitForCompaction();
		emitSuccessfulChildCompaction(id);
		await expect(compactedEvent).resolves.toEqual({ id, compactionCount: originalTarget.state.compactionCount + 1 });
		const checkpointTarget = persistedResumeTargets(id).at(-1)!;
		expect(checkpointTarget).toMatchObject({
			generation: runningTarget.generation,
			revision: 1,
			state: { status: "running", compactionCount: originalTarget.state.compactionCount + 1 },
		});

		controlled.release();
		const resumedResult = await resumedPromise;
		const resumedGeneration = persistedResumeTargets(id).filter((target) => target.generation === runningTarget.generation);
		expect(resumedGeneration.slice(0, 3).map((target) => [target.revision, target.state.status])).toEqual([
			[0, "running"],
			[1, "running"],
			[2, "completed"],
		]);
		expect(resumedGeneration.at(-1)).toMatchObject({
			generation: runningTarget.generation,
			state: { status: "completed", resultConsumed: true },
		});
		expect(resumedResult.isError).toBe(false);
		expect(resumedResult.text).toContain("Fresh restored result RACE-RESULT-83.");
		expect(resumedResult.text).not.toContain("persistence_failed");
		expect(invocationDetails(resumedResult)).toMatchObject({ agentId: id, invocationStatus: "restored_session" });
		expect(manager!.getRecord(id)).toMatchObject({ status: "completed", result: "Fresh restored result RACE-RESULT-83.", toolUses: 0 });
		expect(faux.callCount()).toBe(2);
		expect(faux.pendingResponses()).toBe(0);
		const childJsonl = readFileSync(sessionFile, "utf8");
		expect(childJsonl.match(/Complete the restored race exactly once\./g)).toHaveLength(1);
		expect(childJsonl.match(/Fresh restored result RACE-RESULT-83\./g)).toHaveLength(1);
	});

	it("retains fresh restored output when terminal durability fails after compaction", async () => {
		const session = await createIsolatedSession();
		const faux = nativeFauxHandle();
		faux.appendResponse("Original failure-control result.");
		const firstResult = await invokeAgent("Start terminal fault probe", agentParams("Create the terminal fault target."));
		const id = agentIdFrom(firstResult);
		const sessionFile = sessionFileFor(id);
		const originalTarget = persistedResumeTargets(id).at(-1)!;

		await emitProductionSessionStart(session);
		const controlled = faux.appendControlledResponse("Retained output TERMINAL-FAULT-29.");
		const resumedPromise = invokeAgent(
			"Resume terminal fault probe",
			agentParams("Produce one retained result before the terminal append fault.", id),
		);
		await controlled.started;
		const runningTarget = persistedResumeTargets(id).at(-1)!;
		const compactedEvent = faux.waitForCompaction();
		emitSuccessfulChildCompaction(id);
		await compactedEvent;
		faux.failNextTerminalCommit();
		controlled.release();

		const failedResult = await resumedPromise;
		expect(invocationDetails(failedResult)).toMatchObject({
			agentId: id, invocationStatus: "failed", failureReason: "persistence_failed",
		});
		expect(failedResult.text).toContain("checkpoint did not persist");
		expect(manager!.getRecord(id)).toMatchObject({
			status: "error",
			result: "Retained output TERMINAL-FAULT-29.",
		});
		expect(persistedResumeTargets(id).at(-1)).toMatchObject({
			generation: originalTarget.generation + 1,
			revision: 1,
			state: { status: "running" },
		});
		expect(runningTarget).toMatchObject({ generation: originalTarget.generation + 1, revision: 0 });
		expect(faux.callCount()).toBe(2);
		expect(faux.pendingResponses()).toBe(0);
		faux.appendResponse("Output after authenticated repair TERMINAL-REPAIR-41.");
		const repairedResult = await invokeAgent(
			"Repair terminal fault and continue",
			agentParams("Continue once after authenticating the pending terminal suffix.", id),
		);
		expect(repairedResult.isError).toBe(false);
		expect(repairedResult.text).toContain("Output after authenticated repair TERMINAL-REPAIR-41.");
		expect(faux.callCount()).toBe(3);
		expect(persistedResumeTargets(id)).toEqual(expect.arrayContaining([
			expect.objectContaining({
				generation: originalTarget.generation + 1, revision: 2, state: expect.objectContaining({ status: "completed" }),
			}),
			expect.objectContaining({
				generation: originalTarget.generation + 2, revision: 0, state: expect.objectContaining({ status: "running" }),
			}),
		]));
		const childJsonl = readFileSync(sessionFile, "utf8");
		expect(childJsonl.match(/Produce one retained result before the terminal append fault\./g)).toHaveLength(1);
		expect(childJsonl.match(/Retained output TERMINAL-FAULT-29\./g)).toHaveLength(1);
		expect(childJsonl.match(/Continue once after authenticating the pending terminal suffix\./g)).toHaveLength(1);
		expect(childJsonl.match(/Output after authenticated repair TERMINAL-REPAIR-41\./g)).toHaveLength(1);
	});

	it("rejects a tampered durable prefix without spawning or continuing", async () => {
		const session = await createIsolatedSession();
		const faux = nativeFauxHandle();
		faux.appendResponse("Stored TAMPER-SENTINEL-31.");
		const firstResult = await invokeAgent("Start tamper probe", agentParams("Remember TAMPER-SENTINEL-31."));
		const id = agentIdFrom(firstResult);
		const sessionFile = sessionFileFor(id);
		const childDir = path.dirname(sessionFile);
		const filesBefore = readdirSync(childDir).sort();

		await emitProductionSessionStart(session);
		expect(manager!.getRecord(id)).toBeUndefined();
		writeFileSync(sessionFile, readFileSync(sessionFile, "utf8").replace("TAMPER-SENTINEL-31", "TAMPER-SENTINEL-XX"));

		const result = await invokeAgent("Reject tampered restoration", agentParams("Continue", id));

		expect(result.text).toContain("session_corrupt_or_unsupported");
		expect(invocationDetails(result)).toMatchObject({
			agentId: id, invocationStatus: "failed", failureReason: "session_corrupt_or_unsupported",
		});
		expect(faux.callCount()).toBe(1);
		expect(faux.pendingResponses()).toBe(0);
		expect(manager!.getRecord(id)).toBeUndefined();
		expect(readdirSync(childDir).sort()).toEqual(filesBefore);
	});

	it("explicit fresh calls create independent child sessions", async () => {
		await createIsolatedSession();
		const faux = nativeFauxHandle();
		const firstPrompt = "Fresh child one sentinel FRESH-ONE-23.";
		faux.appendResponse("fresh one");
		const firstResult = await invokeAgent("Start first fresh child", agentParams(firstPrompt));
		const secondPrompt = "Fresh child two must be independent.";
		faux.appendResponse("fresh two");
		const secondResult = await invokeAgent("Start second fresh child", agentParams(secondPrompt));

		const firstId = agentIdFrom(firstResult);
		const secondId = agentIdFrom(secondResult);
		expect(secondId).not.toBe(firstId);
		expect(sessionFileFor(secondId)).not.toBe(sessionFileFor(firstId));
		expect(faux.contexts).toHaveLength(2);
		expect(faux.contexts[1]).toContain(secondPrompt);
		expect(faux.contexts[1]).not.toContain(firstPrompt);
	});

	it("empty resumed turn surfaces as failure and never echoes the prior summary (issue #10 secondary defect)", async () => {
		await createIsolatedSession();
		const faux = nativeFauxHandle();
		const firstPrompt = "Remember sentinel RESUME-STALE-42.";
		faux.appendResponse("Completed: stored RESUME-STALE-42 summary.");
		const firstResult = await invokeAgent("Start stale-resume probe", agentParams(firstPrompt));
		const id = agentIdFrom(firstResult);
		expect(manager!.getRecord(id)?.status).toBe("completed");

		// Resume with a NEW correction, but the resumed turn produces no fresh output.
		// Today resumeAgent falls back to getLastAssistantText and echoes the prior
		// COMPLETED summary as a false-positive resumed_live success (the confirmed
		// defect from archived session 019f6f3e). The fix must surface a failure and
		// never return the stale summary.
		const correction = "Second verification REJECT: apply the correction now.";
		faux.appendResponse("");
		const resumedResult = await invokeAgent("Resume stale-resume probe", agentParams(correction, id));

		expect(resumedResult.text).not.toContain("stored RESUME-STALE-42 summary");
		expect(invocationDetails(resumedResult).invocationStatus).toBe("failed");
	});
});
