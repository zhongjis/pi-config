import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { getPaneContext, parseHerdrSummary } from "../herdr.js";
import sessionSummaryExtension from "../index.js";

const summary = "Investigate railway deployment failure and identify the next debugging step";
beforeEach(() => {
	vi.stubEnv("HC_TERMINAL_ID", "t-current");
	vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent-smart-sessions-test");
	vi.stubEnv("HERDR_ENV", "1");
	vi.stubEnv("HERDR_PANE_ID", "stale-native");
	vi.stubEnv("ORCA_TERMINAL_HANDLE", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("separate host title output", () => {
	it.each([
		["railway issue", "railway issue"],
		["user-managed-wayfinder", "user managed wayfinder"],
		["  user-managed-wayfinder railway issue  ", "user managed wayfinder railway"],
		["one\ttwo\nthree four five", "one two three four"],
	])("bounds whitespace and hyphen separated words in %s", (title, expected) => {
		expect(parseHerdrSummary(JSON.stringify({ summary, title }))).toEqual({ summary, title: expected });
	});
	it.each(["not json", "{}", '{"summary": 1, "title": "issue"}'])("rejects malformed model output %s", (text) => {
		expect(parseHerdrSummary(text)).toBeUndefined();
	});
});

// Stateful app fake: tab.rename changes the name returned by ls.
function app() {
	let name = "Pi";
	const exec = vi.fn<ExtensionAPI["exec"]>(async (_cmd, args) => {
		if (args[0] === "do") name = args[5];
		return { code: 0, stderr: "", killed: false, stdout: JSON.stringify({ spaces: [{ tabs: [
			{ id: "tab-current", name, terminals: [{ terminal: "t-current", pane: "p-current", app: "pi" }] },
		] }] }) };
	});
	return { exec, setName: (next: string) => { name = next; } };
}

async function surface(exec = app().exec) {
	const insideHost = getPaneContext() !== undefined;
	const mock = createMockPi();
	const setSessionName = vi.fn();
	const streamSimple = vi.fn(() => ({ result: async () => ({
		stopReason: "stop", content: [{ type: "text", text: insideHost
			? JSON.stringify({ summary, title: "railway issue" }) : summary }],
	}) }));
	const base = createMockContext();
	const ctx = {
		...base, mode: "tui", cwd: "/nonexistent-smart-sessions-test",
		sessionManager: { ...base.sessionManager, getBranch: () => [{ type: "message", message: { role: "user", content: "Debug the railway deployment" } }] },
		modelRegistry: { ...base.modelRegistry, find: () => base.model, hasConfiguredAuth: () => true, streamSimple },
	};
	Reflect.apply(sessionSummaryExtension, undefined, [{ ...mock.pi, exec, setSessionName, getSessionName: () => "" }]);
	await mock.fireLifecycle("session_start", {}, ctx);
	expect(streamSimple).not.toHaveBeenCalled();
	expect(exec).not.toHaveBeenCalled();
	await mock.fireLifecycle("agent_end", {}, ctx);
	for (let i = 0; i < 20; i++) await Promise.resolve();
	return { mock, ctx, exec, streamSimple, setSessionName };
}

describe("mocked lifecycle surface", () => {
	it("updates app and Pi separately in one existing call, retaining debounce", async () => {
		const { mock, ctx, exec, streamSimple, setSessionName } = await surface();
		expect(setSessionName).toHaveBeenCalledWith(summary);
		expect(exec).toHaveBeenLastCalledWith("herdr-app", ["do", "tab.rename", "--id", "tab-current", "--name", "[w] railway issue"], expect.any(Object));
		await mock.fireLifecycle("agent_end", {}, ctx);
		expect(streamSimple).toHaveBeenCalledTimes(1);
	});
	it("uses plain summaries when only stale native environment variables remain", async () => {
		vi.stubEnv("HC_TERMINAL_ID", "");
		expect(getPaneContext()).toBeUndefined();
		const { exec, streamSimple, setSessionName } = await surface();
		expect(setSessionName).toHaveBeenCalledWith(summary);
		expect(streamSimple).toHaveBeenCalledTimes(1);
		expect(exec).not.toHaveBeenCalled();
	});
});

describe("app title restore on shutdown", () => {
	it.each(["quit", "new", "resume", "fork"])("restores its own title on %s", async (reason) => {
		const { exec } = app();
		const { mock } = await surface(exec);
		await mock.fireLifecycle("session_shutdown", { reason });
		expect(exec).toHaveBeenLastCalledWith("herdr-app", ["do", "tab.rename", "--id", "tab-current", "--name", "Pi"], expect.any(Object));
	});
	it("keeps the title across reload", async () => {
		const { exec } = app();
		const { mock } = await surface(exec);
		const calls = exec.mock.calls.length;
		await mock.fireLifecycle("session_shutdown", { reason: "reload" });
		expect(exec).toHaveBeenCalledTimes(calls);
	});
	it("preserves a name the user set after the takeover", async () => {
		const { exec, setName } = app();
		const { mock } = await surface(exec);
		setName("my project");
		await mock.fireLifecycle("session_shutdown", { reason: "quit" });
		expect(exec).toHaveBeenLastCalledWith("herdr-app", ["ls"], expect.any(Object));
	});
	it("never touches the host when it never renamed", async () => {
		const { exec } = app();
		const mock = createMockPi();
		Reflect.apply(sessionSummaryExtension, undefined, [{ ...mock.pi, exec }]);
		await mock.fireLifecycle("session_shutdown", { reason: "quit" });
		expect(exec).not.toHaveBeenCalled();
	});
});
