import { beforeEach, describe, expect, it, vi } from "vitest";

const STATE_KEY = Symbol.for("pi-extensions.thinking-steps.state");

type LifecycleHandler = (event: unknown, ctx: FakeContext) => unknown | Promise<unknown>;
type PatchRelease = ReturnType<typeof vi.fn<() => Promise<void>>>;

interface FakeContext {
	cwd: string;
	mode: "tui" | "print" | "rpc";
	hasUI: boolean;
	ui: {
		theme: {
			fg(color: string, text: string): string;
			bold(text: string): string;
		};
		notify: ReturnType<typeof vi.fn>;
		setHiddenThinkingLabel: ReturnType<typeof vi.fn>;
		setStatus: ReturnType<typeof vi.fn>;
		select: ReturnType<typeof vi.fn>;
	};
	sessionManager: {
		getEntries: ReturnType<typeof vi.fn>;
	};
}

interface Activation {
	appendEntry: ReturnType<typeof vi.fn>;
	fire(event: string, payload: unknown, ctx?: FakeContext): Promise<void>;
}

interface Harness {
	activate(): Activation;
	retainThinkingStepsPatch: ReturnType<typeof vi.fn>;
	readThinkingStepsModePreference: ReturnType<typeof vi.fn>;
	releases: PatchRelease[];
	state: typeof import("../state.js");
}

function clearThinkingStepsState(): void {
	Reflect.deleteProperty(globalThis, STATE_KEY);
}

async function createHarness(): Promise<Harness> {
	vi.resetModules();
	clearThinkingStepsState();

	const releases: PatchRelease[] = [];
	const releaseFailures: unknown[] = [];
	const retainThinkingStepsPatch = vi.fn();
	const readThinkingStepsModePreference = vi.fn(async () => undefined);

	vi.doMock("../internal-patch.js", async () => {
		const state = await import("../state.js");
		retainThinkingStepsPatch.mockImplementation(async () => {
			state.incrementPatchRefCount();
			const release = vi.fn(async () => {
				state.decrementPatchRefCount();
				const failure = releaseFailures.shift();
				if (failure) {
					state.incrementPatchRefCount();
					throw failure;
				}
			});
			releases.push(release);
			return release;
		});
		return { retainThinkingStepsPatch };
	});

	vi.doMock("../persistence.js", () => ({
		clearThinkingStepsModePreference: vi.fn(async () => undefined),
		readThinkingStepsModePreference,
		writeThinkingStepsModePreference: vi.fn(async () => undefined),
	}));

	const [{ default: thinkingStepsExtension }, state] = await Promise.all([
		import("../index.js"),
		import("../state.js"),
	]);

	return {
		activate() {
			const handlers = new Map<string, LifecycleHandler>();
			const appendEntry = vi.fn();
			thinkingStepsExtension({
				on(event: string, handler: LifecycleHandler) {
					handlers.set(event, handler);
				},
				registerCommand: vi.fn(),
				registerShortcut: vi.fn(),
				appendEntry,
			} as never);
			
			return {
				appendEntry,
				async fire(event: string, payload: unknown, ctx?: FakeContext) {
					if (ctx === undefined && payload && typeof payload === "object" && "mode" in payload && "ui" in payload) {
						await handlers.get(event)?.({ type: event }, payload as FakeContext);
						return;
					}
					await handlers.get(event)?.(payload, ctx as FakeContext);
				}
			};
		},
		retainThinkingStepsPatch,
		readThinkingStepsModePreference,
		releases,
		state,
	};
}

function fakeContext(overrides: Partial<Pick<FakeContext, "cwd" | "mode" | "hasUI">> = {}): FakeContext {
	const hasUI = overrides.hasUI ?? true;
	return {
		cwd: overrides.cwd ?? "/repo",
		mode: overrides.mode ?? "tui",
		hasUI,
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
			notify: vi.fn(),
			setHiddenThinkingLabel: vi.fn(),
			setStatus: vi.fn(),
			select: vi.fn(),
		},
		sessionManager: {
			getEntries: vi.fn(() => []),
		},
	};
}

describe("thinking-steps lifecycle", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("../internal-patch.js");
		vi.doUnmock("../persistence.js");
		clearThinkingStepsState();
	});

	it("keeps the parent TUI patch when a same-cwd headless session shuts down", async () => {
		const harness = await createHarness();
		const parent = harness.activate();
		const print = harness.activate();
		const parentCtx = fakeContext({ cwd: "/repo", mode: "tui", hasUI: true });
		const printCtx = fakeContext({ cwd: "/repo", mode: "print", hasUI: false });

		await parent.fire("session_start", parentCtx);
		await print.fire("session_start", printCtx);
		const [parentRelease] = harness.releases;

		await print.fire("session_shutdown", printCtx);

		expect(harness.retainThinkingStepsPatch).toHaveBeenCalledTimes(1);
		expect(parentRelease).not.toHaveBeenCalled();

		await parent.fire("session_shutdown", parentCtx);

		expect(parentRelease).toHaveBeenCalledTimes(1);
		expect(harness.state.getPatchRefCount()).toBe(0);
	});

	it("does not patch RPC even though hasUI is true", async () => {
		const harness = await createHarness();
		const rpc = harness.activate();
		const ctx = fakeContext({ cwd: "/repo", mode: "rpc", hasUI: true });
		const store = (globalThis as Record<PropertyKey, unknown>)[STATE_KEY] as {
			currentScopeKey: string;
			modeByScopeKey: Record<string, string>;
			activeByScopeKey: Record<string, Record<string, { contentIndex?: number }>>;
			lastActiveByScopeKey: Record<string, { active: boolean }>;
			messageObjectsByScope: Record<string, Set<object>>;
			messageScopeByTimestamp: Record<string, string>;
		};
		const assistantMessage = { role: "assistant", timestamp: 1, content: [] } as { role: "assistant"; timestamp: number; content: unknown[] };
		const snapshot = () => ({
			currentScopeKey: store.currentScopeKey,
			modeKeys: Object.keys(store.modeByScopeKey),
			activeKeys: Object.keys(store.activeByScopeKey),
			lastActiveKeys: Object.keys(store.lastActiveByScopeKey),
			messageOwnerKeys: Object.keys(store.messageObjectsByScope),
			messageScopeKeys: Object.keys(store.messageScopeByTimestamp),
		});
		const before = snapshot();
		
		await rpc.fire("session_start", { type: "session_start" }, ctx);
		await rpc.fire("message_start", { message: assistantMessage });
		await rpc.fire("message_update", { message: assistantMessage, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
		await rpc.fire("message_end", { message: assistantMessage });
		await rpc.fire("agent_end", { type: "agent_end" });
		await rpc.fire("session_shutdown", { type: "session_shutdown" }, ctx);
		const after = snapshot();
		
		expect(harness.retainThinkingStepsPatch).not.toHaveBeenCalled();
		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
		expect(ctx.ui.setHiddenThinkingLabel).not.toHaveBeenCalled();
		expect(ctx.sessionManager.getEntries).not.toHaveBeenCalled();
		expect(harness.readThinkingStepsModePreference).not.toHaveBeenCalled();
		expect(rpc.appendEntry).not.toHaveBeenCalled();
		expect(harness.state.getPatchRefCount()).toBe(0);
		expect(after).toEqual(before);
		expect(store.messageObjectsByScope.__default__?.size).toBe(0);
		expect(harness.state.resolveThinkingMessageScope(assistantMessage, "fallback-scope")).toBe("fallback-scope");
	});

	it("balances TUI reload and repeated TUI owners", async () => {
		const harness = await createHarness();
		const reloaded = harness.activate();
		const firstCtx = fakeContext({ cwd: "/repo", mode: "tui", hasUI: true });
		const secondCtx = fakeContext({ cwd: "/repo", mode: "tui", hasUI: true });

		await reloaded.fire("session_start", firstCtx);
		const firstReloadRelease = harness.releases[0];
		await reloaded.fire("session_shutdown", firstCtx);
		await reloaded.fire("session_start", secondCtx);
		const secondReloadRelease = harness.releases[1];

		expect(firstReloadRelease).toHaveBeenCalledTimes(1);
		expect(secondReloadRelease).not.toHaveBeenCalled();
		expect(harness.state.getPatchRefCount()).toBe(1);

		const first = harness.activate();
		const second = harness.activate();
		const sharedFirstCtx = fakeContext({ cwd: "/shared", mode: "tui", hasUI: true });
		const sharedSecondCtx = fakeContext({ cwd: "/shared", mode: "tui", hasUI: true });

		await first.fire("session_start", sharedFirstCtx);
		await second.fire("session_start", sharedSecondCtx);
		const firstSharedRelease = harness.releases[2];
		const secondSharedRelease = harness.releases[3];

		await first.fire("session_shutdown", sharedFirstCtx);

		expect(firstSharedRelease).toHaveBeenCalledTimes(1);
		expect(secondSharedRelease).not.toHaveBeenCalled();
		expect(harness.state.getPatchRefCount()).toBe(2);

		await second.fire("session_shutdown", sharedSecondCtx);
		await reloaded.fire("session_shutdown", secondCtx);

		expect(secondSharedRelease).toHaveBeenCalledTimes(1);
		expect(secondReloadRelease).toHaveBeenCalledTimes(1);
		expect(harness.retainThinkingStepsPatch).toHaveBeenCalledTimes(4);
		expect(harness.state.getPatchRefCount()).toBe(0);
	});

	it("requeues and retries a failed TUI release", async () => {
		const harness = await createHarness();
		const activation = harness.activate();
		const ctx = fakeContext({ cwd: "/repo", mode: "tui", hasUI: true });

		await activation.fire("session_start", ctx);
		const release = harness.releases[0];
		release.mockRejectedValueOnce(new Error("release failed"));

		await activation.fire("session_shutdown", ctx);

		expect(release).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("release failed"), "warning");
		expect(harness.state.getPatchRefCount()).toBe(1);

		await activation.fire("session_shutdown", ctx);

		expect(release).toHaveBeenCalledTimes(2);
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(harness.state.getPatchRefCount()).toBe(0);
	});
});
