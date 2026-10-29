import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { getHerdrContext, parseHerdrSummary, renameHerdrPane } from "../herdr.js";
import sessionSummaryExtension from "../index.js";

const context = { paneId: "w1:current" };
// Herdr omits `label` for unlabeled panes.
const pane = { pane_id: context.paneId, tab_id: "w1:t1" };
const summary = "Investigate railway deployment failure and identify the next debugging step";

function cli(label?: string) {
	return vi.fn<ExtensionAPI["exec"]>(async () => ({
		code: 0, stderr: "", killed: false,
		stdout: JSON.stringify({ result: { pane: label === undefined ? pane : { ...pane, label } } }),
	}));
}

beforeEach(() => {
	vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent-smart-sessions-test");
	vi.stubEnv("HERDR_ENV", "1");
	vi.stubEnv("HERDR_PANE_ID", context.paneId);
});
afterEach(() => vi.unstubAllEnvs());

describe("Herdr title ownership", () => {
	it.each([undefined, "[w] old title", "[w]"])("renames eligible current label %s", async (label) => {
		const exec = cli(label);
		await renameHerdrPane({ exec }, context, "railway issue");
		expect(exec.mock.calls.map((call) => call[1])).toEqual([
			["pane", "get", context.paneId],
			["pane", "rename", context.paneId, "[w] railway issue"],
		]);
	});

	it.each(["[o] owned", "my project", "railway issue", "2", "[W] custom", ""])("preserves manual current label %j", async (label) => {
		const exec = cli(label);
		await renameHerdrPane({ exec }, context, "railway issue");
		expect(exec).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ code: 1, stdout: "" },
		{ code: 0, stdout: "not json" },
		{ code: 0, stdout: "{}" },
		{ code: 0, stdout: JSON.stringify({ result: { pane: { ...pane, pane_id: "w1:focused" } } }) },
	])("does not mutate for an unusable or mismatched current-pane read: %j", async ({ code, stdout }) => {
		const exec = cli();
		exec.mockResolvedValueOnce({ code, stdout, stderr: "", killed: false });
		await renameHerdrPane({ exec }, context, "railway issue");
		expect(exec).toHaveBeenCalledTimes(1);
	});

	it("skips an empty title without reading Herdr", async () => {
		const exec = cli();
		await renameHerdrPane({ exec }, context, "");
		expect(exec).not.toHaveBeenCalled();
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
		expect(exec).toHaveBeenLastCalledWith("herdr", ["pane", "rename", context.paneId, "[w] railway issue"], expect.any(Object));
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

	it("requires an explicit current-pane identifier", () => {
		vi.stubEnv("HERDR_PANE_ID", "");
		expect(getHerdrContext()).toBeUndefined();
	});
});
