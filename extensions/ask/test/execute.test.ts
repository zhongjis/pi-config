import { describe, expect, it, vi } from "vitest";
import type { createAskDialog, AskDialogResult } from "../dialog.js";
import ask from "../index.js";
import type { AskDetails, IncomingQuestion } from "../types.js";

vi.mock("@earendil-works/pi-tui", async () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

type Dialog = ReturnType<typeof createAskDialog>;
type Factory = (tui: never, theme: never, kb: never, done: (result: AskDialogResult) => void) => Dialog;
type Tool = {
	execute(id: string, params: { questions: IncomingQuestion[]; title?: string }, signal: AbortSignal | undefined, update: undefined, ctx: unknown): Promise<{ content: { type: "text"; text: string }[]; details: AskDetails }>;
};
const question: IncomingQuestion = { id: "q", label: "Scope", prompt: "Which scope?", options: [{ value: "src", label: "Source", description: "Source files" }] };
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
function setup(keys: string[] = ["1"], mode = "tui", duringDialog?: (dialog: Dialog) => void) {
	let tool: Tool | undefined;
	const emit = vi.fn();
	ask({ registerTool: (definition: Tool) => { tool = definition; }, events: { emit }, getSessionName: () => "test-session", getCommands: () => [] } as never);
	const status = vi.fn();
	const tui = { requestRender: vi.fn(), terminal: { rows: 50, columns: 120, setProgramStatus: status } };
	const custom = vi.fn((factory: Factory) => new Promise<AskDialogResult>((resolve) => {
		const dialog = factory(tui as never, theme as never, undefined as never, resolve);
		try {
			duringDialog?.(dialog);
			for (const key of keys) dialog.handleInput(key);
		} finally { dialog.dispose(); }
	}));
	const select = vi.fn(async (_title: string, options: string[]) => options[0]);
	const execute = (questions = [question], signal?: AbortSignal, title?: string) => tool!.execute("call", { questions, title }, signal, undefined, { mode, hasUI: mode !== "print", cwd: process.cwd(), ui: { custom, select } });
	return { execute, custom, select, emit, status };
}

describe("ask execution", () => {
	it("validates before mode or abort checks and never opens UI for invalid payload", async () => {
		const { execute, custom, emit } = setup([], "print");
		const controller = new AbortController();
		controller.abort();
		const result = await execute([{ ...question, id: " ", prompt: "", options: [] }], controller.signal);
		expect(result.content[0].text).toContain("Invalid ask payload:");
		expect(result.details.error?.issues.map((i) => i.path)).toEqual(["questions[0].id", "questions[0].prompt", "questions[0].options"]);
		expect(result.details).toMatchObject({ answers: [], notes: [], cancelled: true, mode: "submit" });
		expect(custom).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalled();
	});
	it("print mode returns a direct question list before abort handling", async () => {
		const { execute, custom } = setup([], "print");
		const controller = new AbortController();
		controller.abort();
		const result = await execute(undefined, controller.signal);
		expect(result.content[0].text).toContain("Needs user input:");
		expect(result.content[0].text).toContain("1. Scope: Which scope? (choose one)");
		expect(result.content[0].text).toContain("   1. Source — Source files");
		expect(result.details).toMatchObject({ answers: [], notes: [], cancelled: true, mode: "submit" });
		expect(result.details.aborted).toBeUndefined();
		expect(custom).not.toHaveBeenCalled();
	});
	it("rpc mode answers through dialog methods without custom UI or Herdr blocking events", async () => {
		const { execute, custom, select, emit } = setup([], "rpc");
		const result = await execute(undefined, undefined, "Decisions");
		expect(select).toHaveBeenCalledWith("Scope: Which scope?", ["1. Source — Source files", "Other…", "Add note…"], { signal: undefined });
		expect(result.content[0].text).toBe("Decisions\nScope: user selected: 1. src");
		expect(result.details).toMatchObject({ mode: "submit", cancelled: false, answers: [{ indices: [1] }] });
		expect(custom).not.toHaveBeenCalled();
		expect(emit.mock.calls).toEqual([["user-prompted", { tool: "ask" }]]);
	});
	it("pre-aborted rpc execution returns aborted without dialogs", async () => {
		const { execute, select } = setup([], "rpc");
		const controller = new AbortController();
		controller.abort();
		const result = await execute(undefined, controller.signal);
		expect(result.details).toMatchObject({ cancelled: true, aborted: true });
		expect(select).not.toHaveBeenCalled();
	});
	it("pre-aborted TUI execution returns aborted without UI or events", async () => {
		const { execute, custom, emit } = setup();
		const controller = new AbortController();
		controller.abort();
		const result = await execute(undefined, controller.signal);
		expect(result.content[0].text).toBe("Ask was aborted before the user answered.");
		expect(result.details).toMatchObject({ cancelled: true, aborted: true });
		expect(custom).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalled();
	});
	it("runs the real component end-to-end and balances prompt/block events and OSC status", async () => {
		const { execute, emit, status, custom } = setup(["N", "explain scope", "\r", "1", "2"]);
		const result = await execute(undefined, undefined, "Decisions");
		expect(custom).toHaveBeenCalledTimes(1);
		expect(result.content[0].text).toContain("(mode: elaborate)");
		expect(result.content[0].text).toContain("Decisions\nScope: user selected: 1. src\nNotes:\n- Scope: explain scope");
		expect(result.details).toMatchObject({ title: "Decisions", cancelled: false, mode: "elaborate", answers: [{ values: ["src"] }], notes: [{ questionId: "q", text: "explain scope" }] });
		expect(emit.mock.calls).toEqual([
			["user-prompted", { tool: "ask" }], ["herdr:blocked", { active: true, label: "Ask" }], ["herdr:blocked", { active: false }],
		]);
		expect(status.mock.calls).toEqual([
			[{ state: "blocked", kind: "question", message: "Ask", app: "pi" }], [{ state: "working", message: "test-session", app: "pi" }],
		]);
	});
	it("abort while the UI is open returns aborted text and restores status", async () => {
		const controller = new AbortController();
		const { execute, status, emit } = setup(["1"], "tui", () => controller.abort());
		const result = await execute(undefined, controller.signal);
		expect(result.content[0].text).toBe("Ask was aborted before the user answered.");
		expect(result.details).toMatchObject({ cancelled: true, aborted: true });
		expect(status.mock.calls.at(-1)?.[0].state).toBe("working");
		expect(emit.mock.calls.at(-1)).toEqual(["herdr:blocked", { active: false }]);
	});
	it("quickPick submit includes title, answer details and no notes", async () => {
		const { execute } = setup();
		const result = await execute(undefined, undefined, "Decisions");
		expect(result.content[0].text).toBe("Decisions\nScope: user selected: 1. src");
		expect(result.details).toMatchObject({ mode: "submit", cancelled: false, notes: [], answers: [{ indices: [1] }] });
		expect(result.details.aborted).toBeUndefined();
	});
});
