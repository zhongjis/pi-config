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
const EXTENSION = path.resolve(PROJECT_ROOT, "extensions/handoff/index.ts");

const MOCK_TOOLS = {
	bash: (params: Record<string, unknown>) => `$ ${params.command}\nok`,
	read: "mock file contents",
	write: "mock written",
	edit: "mock edited",
};

describe("handoff extension — integration", () => {
	let t: TestSession;
	afterEach(() => t?.dispose());

	// ── Loading ─────────────────────────────────────────────────

	it("loads without errors", async () => {
		// createTestSession throws on extension load errors
		t = await createTestSession({
			cwd: PROJECT_ROOT,
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
		});

		expect(t.session).toBeDefined();
	});

	it("registers /handoff and /handoff:start-work commands", async () => {
		t = await createTestSession({
			cwd: PROJECT_ROOT,
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
		});

		const runner = (t.session as any).extensionRunner;
		expect(runner).toBeDefined();

		const commands = runner.getRegisteredCommands() as Array<{ name: string }>;
		const commandNames = commands.map((c: { name: string }) => c.name);
		expect(commandNames).toContain("handoff");
		expect(commandNames).toContain("handoff:start-work");
	});

	// ── Direct handoff bridge event flow ────────────────────────

	it("bridge responds to valid handoff:rpc:prepare request", async () => {
		// Capture the event bus from an inline extension factory
		let eventBus: { emit: (ch: string, data: unknown) => void; on: (ch: string, handler: (data: unknown) => void) => () => void } | null = null;

		t = await createTestSession({
			cwd: PROJECT_ROOT,
			extensions: [EXTENSION],
			extensionFactories: [
				(pi: any) => {
					eventBus = pi.events;
				},
			],
			mockTools: MOCK_TOOLS,
		});

		expect(eventBus).not.toBeNull();

		// Simulate the bridge request flow that requestDirectHandoffBridge uses
		const requestId = `test-${Date.now()}`;
		const replyChannel = `handoff:rpc:prepare:reply:${requestId}`;

		const replyPromise = new Promise<any>((resolve) => {
			const unsub = eventBus!.on(replyChannel, (data: unknown) => {
				unsub();
				resolve(data);
			});
		});

		eventBus!.emit("handoff:rpc:prepare", {
			requestId,
			request: {
				sessionFile: "/tmp/test-session.jsonl",
				goal: "implement the feature",
				mode: "houtu",
				summarize: false,
			},
		});

		const reply = await replyPromise;
		expect(reply).toBeDefined();
		expect(reply.success).toBe(true);
		expect(reply.data.command).toBe("/handoff:start-work");
		expect(reply.data.sessionFile).toBe("/tmp/test-session.jsonl");
	});

	it("bridge responds with error for missing goal", async () => {
		let eventBus: any = null;

		t = await createTestSession({
			cwd: PROJECT_ROOT,
			extensions: [EXTENSION],
			extensionFactories: [(pi: any) => { eventBus = pi.events; }],
			mockTools: MOCK_TOOLS,
		});

		const requestId = `test-err-${Date.now()}`;
		const replyChannel = `handoff:rpc:prepare:reply:${requestId}`;

		const replyPromise = new Promise<any>((resolve) => {
			const unsub = eventBus.on(replyChannel, (data: unknown) => {
				unsub();
				resolve(data);
			});
		});

		eventBus.emit("handoff:rpc:prepare", {
			requestId,
			request: {
				sessionFile: "/tmp/test-session.jsonl",
				goal: "",
				mode: "houtu",
				summarize: false,
			},
		});

		const reply = await replyPromise;
		expect(reply.success).toBe(false);
		expect(reply.error).toContain("Missing handoff goal");
	});

	it("bridge responds with error for invalid mode", async () => {
		let eventBus: any = null;

		t = await createTestSession({
			cwd: PROJECT_ROOT,
			extensions: [EXTENSION],
			extensionFactories: [(pi: any) => { eventBus = pi.events; }],
			mockTools: MOCK_TOOLS,
		});

		const requestId = `test-mode-${Date.now()}`;
		const replyChannel = `handoff:rpc:prepare:reply:${requestId}`;

		const replyPromise = new Promise<any>((resolve) => {
			const unsub = eventBus.on(replyChannel, (data: unknown) => {
				unsub();
				resolve(data);
			});
		});

		eventBus.emit("handoff:rpc:prepare", {
			requestId,
			request: {
				sessionFile: "/tmp/test-session.jsonl",
				goal: "do the thing",
				mode: "invalid-mode",
				summarize: false,
			},
		});

		const reply = await replyPromise;
		expect(reply.success).toBe(false);
		expect(reply.error).toContain("Unknown mode");
	});

	it("bridge responds with error for missing request", async () => {
		let eventBus: any = null;

		t = await createTestSession({
			cwd: PROJECT_ROOT,
			extensions: [EXTENSION],
			extensionFactories: [(pi: any) => { eventBus = pi.events; }],
			mockTools: MOCK_TOOLS,
		});

		const requestId = `test-missing-${Date.now()}`;
		const replyChannel = `handoff:rpc:prepare:reply:${requestId}`;

		const replyPromise = new Promise<any>((resolve) => {
			const unsub = eventBus.on(replyChannel, (data: unknown) => {
				unsub();
				resolve(data);
			});
		});

		eventBus.emit("handoff:rpc:prepare", {
			requestId,
			// no request
		});

		const reply = await replyPromise;
		expect(reply.success).toBe(false);
		expect(reply.error).toContain("Missing handoff bridge request");
	});

	it("bridge accepts mode aliases (build → kuafu)", async () => {
		let eventBus: any = null;

		t = await createTestSession({
			cwd: PROJECT_ROOT,
			extensions: [EXTENSION],
			extensionFactories: [(pi: any) => { eventBus = pi.events; }],
			mockTools: MOCK_TOOLS,
		});

		const requestId = `test-alias-${Date.now()}`;
		const replyChannel = `handoff:rpc:prepare:reply:${requestId}`;

		const replyPromise = new Promise<any>((resolve) => {
			const unsub = eventBus.on(replyChannel, (data: unknown) => {
				unsub();
				resolve(data);
			});
		});

		eventBus.emit("handoff:rpc:prepare", {
			requestId,
			request: {
				sessionFile: "/tmp/test-alias.jsonl",
				goal: "build the feature",
				mode: "build",
				summarize: true,
			},
		});

		const reply = await replyPromise;
		expect(reply.success).toBe(true);
		expect(reply.data.command).toBe("/handoff:start-work");
	});

	it("bridge includes source field when provided", async () => {
		let eventBus: any = null;

		t = await createTestSession({
			cwd: PROJECT_ROOT,
			extensions: [EXTENSION],
			extensionFactories: [(pi: any) => { eventBus = pi.events; }],
			mockTools: MOCK_TOOLS,
		});

		const requestId = `test-source-${Date.now()}`;
		const replyChannel = `handoff:rpc:prepare:reply:${requestId}`;

		const replyPromise = new Promise<any>((resolve) => {
			const unsub = eventBus.on(replyChannel, (data: unknown) => {
				unsub();
				resolve(data);
			});
		});

		eventBus.emit("handoff:rpc:prepare", {
			requestId,
			request: {
				sessionFile: "/tmp/test-source.jsonl",
				goal: "execute the plan",
				mode: "houtu",
				summarize: false,
				source: "modes-extension",
			},
		});

		const reply = await replyPromise;
		expect(reply.success).toBe(true);
		expect(reply.data.source).toBe("modes-extension");
	});

	// ── Bridge ignores malformed events ─────────────────────────

	it("bridge ignores events without requestId", async () => {
		let eventBus: any = null;

		t = await createTestSession({
			cwd: PROJECT_ROOT,
			extensions: [EXTENSION],
			extensionFactories: [(pi: any) => { eventBus = pi.events; }],
			mockTools: MOCK_TOOLS,
		});

		// Emit with no requestId — should be silently ignored (no crash)
		eventBus.emit("handoff:rpc:prepare", { noRequestId: true });

		// Emit a valid request after to confirm bridge is still alive
		const requestId = `test-after-bad-${Date.now()}`;
		const replyChannel = `handoff:rpc:prepare:reply:${requestId}`;

		const replyPromise = new Promise<any>((resolve) => {
			const unsub = eventBus.on(replyChannel, (data: unknown) => {
				unsub();
				resolve(data);
			});
		});

		eventBus.emit("handoff:rpc:prepare", {
			requestId,
			request: {
				sessionFile: "/tmp/test-recover.jsonl",
				goal: "recover",
				mode: "kuafu",
				summarize: false,
			},
		});

		const reply = await replyPromise;
		expect(reply.success).toBe(true);
	});

	// ── Prepared handoff resolver ───────────────────────────────
	// The prepared handoff flow: another extension (modes) sets a resolver
	// via setPreparedHandoffArgsResolver. When /handoff:start-work runs,
	// it checks the resolver if no pending handoff exists for the session.
	//
	// Testing this fully requires both extensions loaded together and
	// invoking the command handler. Since command handlers need ctx.hasUI,
	// ctx.sessionManager.getSessionFile(), and ctx.newSession() — all
	// process-boundary concerns — full end-to-end prepared handoff is not
	// testable via the playbook harness.
	//
	// What IS testable: the resolver registration mechanism via globalThis.

	it("setPreparedHandoffArgsResolver is accessible from extension exports", async () => {
		// Import the function directly — this verifies the extension's exports work
		const { setPreparedHandoffArgsResolver, parseHandoffArgs } = await import(
			"../../extensions/handoff/runtime.js"
		);

		// Verify parseHandoffArgs works with various inputs
		const result1 = parseHandoffArgs("-mode houtu -no-summarize implement the plan");
		expect(result1.ok).toBe(true);
		if (result1.ok) {
			expect(result1.value.mode).toBe("houtu");
			expect(result1.value.summarize).toBe(false);
			expect(result1.value.goal).toBe("implement the plan");
		}

		const result2 = parseHandoffArgs("-mode build fix the bug");
		expect(result2.ok).toBe(true);
		if (result2.ok) {
			expect(result2.value.mode).toBe("kuafu");
			expect(result2.value.summarize).toBe(true);
		}

		const result3 = parseHandoffArgs("");
		expect(result3.ok).toBe(false);

		const result4 = parseHandoffArgs("-mode invalid-mode do something");
		expect(result4.ok).toBe(false);

		// Verify resolver can be set and cleared without error
		setPreparedHandoffArgsResolver(() => ({
			goal: "test",
			mode: "houtu" as const,
			summarize: false,
		}));
		setPreparedHandoffArgsResolver(null);
	});

	// ── Session shutdown unsubscribes bridge ────────────────────
	// session.dispose() does NOT fire session_shutdown (per harness docs).
	// session_shutdown fires at Node.js process exit. We cannot test the
	// unsubscribe behavior through the test harness.
	//
	// However, we CAN verify the bridge subscription is active by checking
	// that bridge requests get replies (already tested above), and that
	// the extension sets up the shutdown handler (verified by extension
	// loading without errors).

	// ── /handoff command error paths ────────────────────────────
	// The /handoff command handler calls parseHandoffArgs and notifies on
	// error. Command handlers are invoked outside the playbook (they're
	// user-initiated slash commands). Testing them requires accessing
	// the command registry and invoking the handler directly.

	it("/handoff command handler notifies on empty args", async () => {
		t = await createTestSession({
			cwd: PROJECT_ROOT,
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
		});

		const runner = (t.session as any).extensionRunner;
		const commands = runner.getRegisteredCommands() as Array<{ name: string; handler: (args: string, ctx: any) => Promise<void> }>;
		const handoffCmd = commands.find((c) => c.name === "handoff");
		expect(handoffCmd).toBeDefined();

		// Create a mock ctx that captures notify calls
		const notifications: Array<{ message: string; level: string }> = [];
		const mockCtx = {
			ui: {
				notify: (message: string, level: string) => {
					notifications.push({ message, level });
				},
			},
		};

		await handoffCmd!.handler("", mockCtx);

		expect(notifications).toHaveLength(1);
		expect(notifications[0].level).toBe("error");
		expect(notifications[0].message).toContain("Usage:");
	});

	it("/handoff command handler notifies on invalid mode", async () => {
		t = await createTestSession({
			cwd: PROJECT_ROOT,
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
		});

		const runner = (t.session as any).extensionRunner;
		const commands = runner.getRegisteredCommands() as Array<{ name: string; handler: (args: string, ctx: any) => Promise<void> }>;
		const handoffCmd = commands.find((c) => c.name === "handoff");

		const notifications: Array<{ message: string; level: string }> = [];
		const mockCtx = {
			ui: {
				notify: (message: string, level: string) => {
					notifications.push({ message, level });
				},
			},
		};

		await handoffCmd!.handler("-mode bogus do something", mockCtx);

		expect(notifications).toHaveLength(1);
		expect(notifications[0].level).toBe("error");
		expect(notifications[0].message).toContain("Unknown mode");
		expect(notifications[0].message).toContain("bogus");
	});

	// ── /handoff command with valid args but no UI ──────────────

	it("/handoff command returns error when hasUI is false", async () => {
		t = await createTestSession({
			cwd: PROJECT_ROOT,
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
		});

		const runner = (t.session as any).extensionRunner;
		const commands = runner.getRegisteredCommands() as Array<{ name: string; handler: (args: string, ctx: any) => Promise<void> }>;
		const handoffCmd = commands.find((c) => c.name === "handoff");

		const notifications: Array<{ message: string; level: string }> = [];
		const mockCtx = {
			hasUI: false,
			sessionManager: {
				getSessionFile: () => "/tmp/test.jsonl",
				getBranch: () => [],
			},
			ui: {
				notify: (message: string, level: string) => {
					notifications.push({ message, level });
				},
			},
		};

		await handoffCmd!.handler("-mode kuafu fix the bug", mockCtx);

		expect(notifications).toHaveLength(1);
		expect(notifications[0].message).toContain("interactive mode");
	});

	// ── /handoff:start-work with no prepared handoff ────────────

	it("/handoff:start-work notifies when no prepared handoff exists", async () => {
		t = await createTestSession({
			cwd: PROJECT_ROOT,
			extensions: [EXTENSION],
			mockTools: MOCK_TOOLS,
		});

		const runner = (t.session as any).extensionRunner;
		const commands = runner.getRegisteredCommands() as Array<{ name: string; handler: (args: string, ctx: any) => Promise<void> }>;
		const startWorkCmd = commands.find((c) => c.name === "handoff:start-work");
		expect(startWorkCmd).toBeDefined();

		const notifications: Array<{ message: string; level: string }> = [];
		const mockCtx = {
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "/tmp/no-prepared-handoff.jsonl",
				getBranch: () => [],
			},
			ui: {
				notify: (message: string, level: string) => {
					notifications.push({ message, level });
				},
			},
		};

		await startWorkCmd!.handler("", mockCtx);

		expect(notifications).toHaveLength(1);
		expect(notifications[0].level).toBe("error");
		expect(notifications[0].message).toContain("No prepared handoff found");
	});
});
