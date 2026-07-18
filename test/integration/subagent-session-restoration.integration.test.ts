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
	abort?: () => void;
	dispose?: () => void;
}

interface AgentRecordLike {
	id: string;
	session?: SessionLike;
	sessionFile?: string;
	status?: string;
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

function installFixture(): { cwd: string; wrapperPath: string } {
	fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-subagent-restoration-"));
	const cwd = path.join(fixtureRoot, "project");
	const agentDir = path.join(fixtureRoot, "agent-dir");
	const wrapperDir = path.join(fixtureRoot, "extensions");
	const wrapperPath = path.join(wrapperDir, "subagent-native-faux.ts");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	mkdirSync(wrapperDir, { recursive: true });
	writeFileSync(
		path.join(agentDir, "agents", `${AGENT_TYPE}.md`),
		`---
description: Deterministic session restoration probe
prompt_mode: replace
builtin_tools: read
extensions: false
---

Answer only from this conversation.
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

export default function(pi: ExtensionAPI) {
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
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    }],
  });
  const handle = {
    contexts: [] as string[],
    appendResponse(text: string) {
      faux.appendResponses([(context) => {
        handle.contexts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(text);
      }]);
    },
    pendingResponses: () => faux.getPendingResponseCount(),
    callCount: () => faux.state.callCount,
    unregister: () => faux.unregister(),
  };
  (globalThis as Record<PropertyKey, unknown>)[HANDLE] = handle;
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
		isolated: true,
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
