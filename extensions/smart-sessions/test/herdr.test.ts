import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { getHerdrContext, parseHerdrSummary, renameHerdrTab } from "../herdr.js";
import sessionSummaryExtension from "../index.js";

const context = { tabId: "workspace:current", workspaceId: "workspace" };
const tab = { tab_id: context.tabId, workspace_id: context.workspaceId, label: "2", number: 178 };
const summary = "Investigate railway deployment failure and identify the next debugging step";

function cli(label = "2") {
	return vi.fn<ExtensionAPI["exec"]>(async (_command, args) => ({
		code: 0, stderr: "", killed: false,
		stdout: JSON.stringify({ result: args[1] === "list"
			? { tabs: [{ ...tab, tab_id: "workspace:other" }, tab] }
			: { tab: { ...tab, label } } }),
	}));
}

beforeEach(() => {
	vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent-smart-sessions-test");
	vi.stubEnv("HERDR_ENV", "1");
	vi.stubEnv("HERDR_TAB_ID", context.tabId);
	vi.stubEnv("HERDR_WORKSPACE_ID", context.workspaceId);
});
afterEach(() => vi.unstubAllEnvs());

describe("Herdr title ownership", () => {
	it.each(["2", "[w] old title", "[w]"])("renames eligible current label %s", async (label) => {
		const exec = cli(label);
		await renameHerdrTab({ exec }, context, "railway issue");
		expect(exec.mock.calls.map((call) => call[1][1])).toEqual(["list", "get", "rename"]);
		expect(exec).toHaveBeenLastCalledWith("herdr", ["tab", "rename", context.tabId, "[w] railway issue"], expect.any(Object));
	});

	it.each(["[o] owned", "[x] custom", "my project", "railway issue", "178", "1", "[W] custom"])("preserves protected current label %s", async (label) => {
		const exec = cli(label);
		await renameHerdrTab({ exec }, context, "railway issue");
		expect(exec.mock.calls.map((call) => call[1][1])).toEqual(["list", "get"]);
	});

	it("reads a manual opt-out after the tab list rather than trusting its default label", async () => {
		const exec = cli("manually renamed");
		await renameHerdrTab({ exec }, context, "railway issue");
		expect(exec).toHaveBeenLastCalledWith("herdr", ["tab", "get", context.tabId], expect.any(Object));
	});

	it("resolves a missing workspace from the explicit current tab, never the focused tab", async () => {
		const exec = cli();
		await renameHerdrTab({ exec }, { tabId: context.tabId }, "railway issue");
		expect(exec.mock.calls.map((call) => call[1][1])).toEqual(["get", "list", "get", "rename"]);
		expect(exec.mock.calls[1]?.[1]).toEqual(["tab", "list", "--workspace", context.workspaceId]);
	});

	it.each(["{}", "not json", JSON.stringify({ result: { tabs: [] } })])("does not mutate for an unusable tab list: %s", async (stdout) => {
		const exec = cli();
		exec.mockResolvedValueOnce({ code: 0, stdout, stderr: "", killed: false });
		await renameHerdrTab({ exec }, context, "railway issue");
		expect(exec).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ ...tab, tab_id: "workspace:focused" },
		{ ...tab, workspace_id: "another-workspace" },
	])("preserves tabs when the current-tab response has mismatched identity: %s", async (current) => {
		const exec = cli();
		exec.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ result: { tabs: [tab] } }), stderr: "", killed: false });
		exec.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ result: { tab: current } }), stderr: "", killed: false });
		await renameHerdrTab({ exec }, context, "railway issue");
		expect(exec).toHaveBeenCalledTimes(2);
	});

	it("does not mutate after a failed current-tab read", async () => {
		const exec = cli();
		exec.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ result: { tabs: [tab] } }), stderr: "", killed: false });
		exec.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "unavailable", killed: false });
		await renameHerdrTab({ exec }, context, "railway issue");
		expect(exec).toHaveBeenCalledTimes(2);
	});
});

describe("separate Herdr title output", () => {
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

// Lifecycle surface driver: every CLI execution is replaced; never reaches live Herdr.
async function surface(insideHerdr: boolean) {
	if (!insideHerdr) vi.stubEnv("HERDR_ENV", "");
	const mock = createMockPi();
	const exec = cli();
	const setSessionName = vi.fn();
	const streamSimple = vi.fn(() => ({ result: async () => ({
		stopReason: "stop", content: [{ type: "text", text: insideHerdr
			? JSON.stringify({ summary, title: "railway issue" }) : summary }],
	}) }));
	const base = createMockContext();
	const ctx = {
		...base, cwd: "/nonexistent-smart-sessions-test",
		sessionManager: { ...base.sessionManager, getBranch: () => [{ type: "message", message: { role: "user", content: "Debug the railway deployment" } }] },
		modelRegistry: { ...base.modelRegistry, find: () => base.model, hasConfiguredAuth: () => true, streamSimple },
	};
	Reflect.apply(sessionSummaryExtension, undefined, [{ ...mock.pi, exec, setSessionName, getSessionName: () => "" }]);
	await mock.fireLifecycle("session_start", {}, ctx);
	expect(streamSimple).not.toHaveBeenCalled();
	expect(exec).not.toHaveBeenCalled();
	await mock.fireLifecycle("agent_end", {}, ctx);
	// Drain the fire-and-forget summary and mocked CLI microtasks without clock sleeps.
	for (let i = 0; i < 20; i++) await Promise.resolve();
	return { mock, ctx, exec, streamSimple, setSessionName };
}

describe("mocked lifecycle surface", () => {
	it("updates Herdr and Pi separately in one existing call, retaining debounce", async () => {
		const { mock, ctx, exec, streamSimple, setSessionName } = await surface(true);
		expect(setSessionName).toHaveBeenCalledWith(summary);
		expect(exec).toHaveBeenLastCalledWith("herdr", ["tab", "rename", context.tabId, "[w] railway issue"], expect.any(Object));
		await mock.fireLifecycle("agent_end", {}, ctx);
		expect(streamSimple).toHaveBeenCalledTimes(1);
	});

	it("preserves the plain summary path and never executes Herdr outside its context", async () => {
		const { exec, streamSimple, setSessionName } = await surface(false);
		expect(setSessionName).toHaveBeenCalledWith(summary);
		expect(streamSimple).toHaveBeenCalledTimes(1);
		expect(exec).not.toHaveBeenCalled();
		expect(getHerdrContext()).toBeUndefined();
	});

	it("requires an explicit current-tab identifier", () => {
		vi.stubEnv("HERDR_TAB_ID", "");
		expect(getHerdrContext()).toBeUndefined();
	});
});
