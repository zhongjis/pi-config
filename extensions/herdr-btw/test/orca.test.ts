import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { registerBtwExtension } from "../index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { ContextStore } from "../src/context-store.ts";
import {
	buildOrcaSplitArgs,
	createPayload,
	parseOrcaRetrySplitLeaf,
	parseOrcaSplitHandle,
	shellQuote,
	type HerdrLaunchOptions,
} from "../src/core.ts";

const launch: HerdrLaunchOptions = {
	paneName: "btw", cwd: "/tmp", payloadPath: "/tmp/it's a dir/payload.json", model: "test/model",
	sessionDir: "/tmp/btw sessions/s", thinkingLevel: "standard", toolMode: "none", activeTools: [], split: "right",
	initialMessage: "/btw --launch-draft",
};

describe("Orca launch argv", () => {
	it("splits the parent and quotes every shell-visible argument", () => {
		const args = buildOrcaSplitArgs(launch, "term_parent");
		expect(args.slice(0, 6)).toEqual(["terminal", "split", "--terminal", "term_parent", "--direction", "vertical"]);
		expect(args).toContain("--json");
		const command = args[args.indexOf("--command") + 1];
		expect(command).toBe(
			"env PI_HERDR_BTW_PAYLOAD='/tmp/it'\\''s a dir/payload.json' pi '--session-dir' '/tmp/btw sessions/s' '--model' 'test/model' '--thinking' 'standard' '--no-tools' '/btw --launch-draft'",
		);
	});

	it("maps a downward split to a horizontal Orca split", () => {
		expect(buildOrcaSplitArgs({ ...launch, split: "down" }, "t")).toContain("horizontal");
	});

	it.each(["plain", "with space", "it's", "$(rm -rf x)", "a;b`c`", ""])("quotes %j as a single literal word", (arg) => {
		expect(shellQuote(arg)).toBe(`'${arg.replaceAll("'", "'\\''")}'`);
	});

	it("parses the split handle and retry leaf", () => {
		expect(parseOrcaSplitHandle('{"result":{"split":{"handle":"term_new"}}}')).toBe("term_new");
		expect(parseOrcaSplitHandle('{"result":{"split":{}}}')).toBeNull();
		expect(parseOrcaSplitHandle("nope")).toBeNull();
		expect(parseOrcaRetrySplitLeaf("", "timed out; re-run with --retry-split leaf_9")).toBe("leaf_9");
		expect(parseOrcaRetrySplitLeaf("", "")).toBeNull();
	});
});

const ui = { setTitle() {}, setWidget() {}, setEditorText() {}, notify: vi.fn(), theme: { fg: (_c: string, text: string) => text } };

describe("Orca parent launch", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "btw-orca-"));
		vi.stubEnv("HC_TERMINAL_ID", "");
		vi.stubEnv("PI_HERDR_BTW_PAYLOAD", "");
		vi.stubEnv("HERDR_ENV", "");
		vi.stubEnv("HERDR_PANE_ID", "");
		vi.stubEnv("ORCA_TERMINAL_HANDLE", "term_parent");
		ui.notify.mockClear();
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	async function run(execResult: { code: number; stdout: string; stderr: string; killed?: boolean }) {
		const mock = createMockPi();
		const exec = vi.fn().mockResolvedValue(execResult);
		Object.assign(mock.pi, { exec, getAllTools: () => [{ name: "read" }], getActiveTools: () => ["read"] });
		const store = new ContextStore(root);
		const remove = vi.spyOn(store, "remove");
		await Reflect.apply(registerBtwExtension, undefined, [mock.pi, {
			store,
			configStore: { load: async () => ({ ...DEFAULT_CONFIG }), save: async () => {}, reset: async () => ({ ...DEFAULT_CONFIG }) },
		}]);
		const ctx = { mode: "tui", ui, cwd: root, model: { provider: "test", id: "model" }, getSystemPrompt: () => "p", isIdle: () => true,
			sessionManager: { getSessionId: () => "parent-session", getSessionFile: () => undefined, getLeafId: () => null, getEntries: () => [{ type: "message", message: { role: "user", content: "hello" } }] },
		};
		await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
		const command = mock.commands.get("btw");
		if (!command || typeof command !== "object" || !("handler" in command) || typeof command.handler !== "function") throw new Error("btw not registered");
		await Reflect.apply(command.handler, command, ["question", ctx]);
		await mock.fireLifecycle("session_shutdown");
		return { exec, remove };
	}

	it("launches with a single Orca split from the parent handle", async () => {
		const { exec, remove } = await run({ code: 0, stdout: '{"result":{"split":{"handle":"term_new"}}}', stderr: "" });
		expect(exec).toHaveBeenCalledTimes(1);
		expect(exec.mock.calls[0]?.[0]).toBe("orca");
		expect(exec.mock.calls[0]?.[1].slice(0, 4)).toEqual(["terminal", "split", "--terminal", "term_parent"]);
		expect(remove).not.toHaveBeenCalled();
	});

	it("reports a failed split and removes the payload", async () => {
		const { remove } = await run({ code: 1, stdout: "", stderr: "boom" });
		expect(remove).toHaveBeenCalledTimes(1);
		expect(ui.notify).toHaveBeenCalledWith("/btw failed: boom", "error");
	});

	it("keeps the payload and points at --retry-split after a timeout", async () => {
		const { exec, remove } = await run({ code: 1, stdout: "", stderr: "use --retry-split leaf_7", killed: true });
		expect(exec).toHaveBeenCalledTimes(1);
		expect(remove).not.toHaveBeenCalled();
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("--retry-split leaf_7"), "warning");
	});

	it("rejects a split result without a handle", async () => {
		const { remove } = await run({ code: 0, stdout: "{}", stderr: "" });
		expect(remove).toHaveBeenCalledTimes(1);
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("terminal handle"), "error");
	});
});

describe("Orca child shutdown", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "btw-orca-child-"));
		vi.stubEnv("HC_TERMINAL_ID", "");
		vi.stubEnv("HERDR_ENV", "");
		vi.stubEnv("HERDR_PANE_ID", "");
		vi.stubEnv("ORCA_TERMINAL_HANDLE", "term_child");
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	it("switches to the parent then closes its own terminal when closeOnExit is set", async () => {
		const store = new ContextStore(root);
		const payload = createPayload({
			createdAt: new Date().toISOString(), parentSessionId: "s", parentPaneId: "term_parent",
			metadata: { generatedAt: "now", cwd: "/tmp", session: "s", model: "test/model" },
			parentSystemPrompt: null, parentActiveTools: [], parentThinkingLevel: "medium",
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }], draftQuestion: "",
			config: { ...DEFAULT_CONFIG, closeOnExit: true },
		});
		vi.stubEnv("PI_HERDR_BTW_PAYLOAD", await store.create(payload));
		const mock = createMockPi();
		const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
		Object.assign(mock.pi, { exec });
		await Reflect.apply(registerBtwExtension, undefined, [mock.pi, { store }]);
		await mock.fireLifecycle("session_shutdown", { reason: "quit" }, { mode: "tui" });
		expect(exec.mock.calls.map((call) => [call[0], call[1]])).toEqual([
			["orca", ["terminal", "switch", "--terminal", "term_parent"]],
			["orca", ["terminal", "close", "--terminal", "term_child"]],
		]);
		expect(exec.mock.calls.every((call) => call[2].timeout === 5_000)).toBe(true);
	});
});
