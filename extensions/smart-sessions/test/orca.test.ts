import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { getPaneContext, renameOrcaPane } from "../herdr.js";
import sessionSummaryExtension from "../index.js";

const context = { handle: "term_current" };
const summary = "Investigate railway deployment failure and identify the next debugging step";

// Orca omits `paneTitle` for panes without a custom title; `title` is auto-derived and never matched.
function cli(paneTitle?: string) {
	return vi.fn<ExtensionAPI["exec"]>(async () => ({
		code: 0, stderr: "", killed: false,
		stdout: JSON.stringify({ result: { terminal: paneTitle === undefined ? { title: "zsh" } : { title: "zsh", paneTitle } } }),
	}));
}

beforeEach(() => {
	vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent-smart-sessions-test");
	vi.stubEnv("HERDR_ENV", "");
	vi.stubEnv("HERDR_PANE_ID", "");
	vi.stubEnv("ORCA_TERMINAL_HANDLE", context.handle);
});
afterEach(() => vi.unstubAllEnvs());

describe("Orca title ownership", () => {
	it.each([undefined, "[w] old title", "[w]"])("renames eligible current title %s", async (title) => {
		const exec = cli(title);
		await renameOrcaPane({ exec }, context, "railway issue");
		expect(exec.mock.calls.map((call) => call[1])).toEqual([
			["terminal", "show", "--terminal", context.handle, "--json"],
			["terminal", "set-pane-title", "--terminal", context.handle, "--title", "[w] railway issue"],
		]);
		expect(exec.mock.calls[0]?.[2]).toMatchObject({ timeout: 3000 });
	});

	it.each(["[o] owned", "my project", "railway issue", "[W] custom", ""])("preserves manual current title %j", async (title) => {
		const exec = cli(title);
		await renameOrcaPane({ exec }, context, "railway issue");
		expect(exec).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ code: 1, stdout: "" },
		{ code: 0, stdout: "not json" },
		{ code: 0, stdout: "{}" },
	])("does not mutate for an unusable current-terminal read: %j", async ({ code, stdout }) => {
		const exec = cli();
		exec.mockResolvedValueOnce({ code, stdout, stderr: "", killed: false });
		await renameOrcaPane({ exec }, context, "railway issue");
		expect(exec).toHaveBeenCalledTimes(1);
	});

	it("skips an empty title without reading Orca", async () => {
		const exec = cli();
		await renameOrcaPane({ exec }, context, "");
		expect(exec).not.toHaveBeenCalled();
	});
});

describe("pane context selection", () => {
	it("selects Orca by its terminal handle", () => {
		expect(getPaneContext()).toEqual({ host: "orca", handle: context.handle });
	});

	it("prefers Herdr when both hosts are present", () => {
		vi.stubEnv("HERDR_ENV", "1");
		vi.stubEnv("HERDR_PANE_ID", "w1:current");
		expect(getPaneContext()).toEqual({ host: "herdr", paneId: "w1:current" });
	});
});

describe("mocked lifecycle surface", () => {
	it("updates Orca title and Pi summary from one existing call", async () => {
		const mock = createMockPi();
		const exec = cli();
		const setSessionName = vi.fn();
		const streamSimple = vi.fn(() => ({ result: async () => ({
			stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ summary, title: "railway issue" }) }],
		}) }));
		const base = createMockContext();
		const ctx = {
			...base, mode: "tui", cwd: "/nonexistent-smart-sessions-test",
			sessionManager: { ...base.sessionManager, getBranch: () => [{ type: "message", message: { role: "user", content: "Debug the railway deployment" } }] },
			modelRegistry: { ...base.modelRegistry, find: () => base.model, hasConfiguredAuth: () => true, streamSimple },
		};
		Reflect.apply(sessionSummaryExtension, undefined, [{ ...mock.pi, exec, setSessionName, getSessionName: () => "" }]);
		await mock.fireLifecycle("session_start", {}, ctx);
		await mock.fireLifecycle("agent_end", {}, ctx);
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(setSessionName).toHaveBeenCalledWith(summary);
		expect(exec).toHaveBeenLastCalledWith(
			"orca",
			["terminal", "set-pane-title", "--terminal", context.handle, "--title", "[w] railway issue"],
			expect.any(Object),
		);
	});
});
