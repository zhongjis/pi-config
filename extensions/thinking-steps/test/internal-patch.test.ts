import { afterEach, describe, expect, it, vi } from "vitest";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const MAX_TOKENS_ERROR = "Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.";
const STATE_KEY = Symbol.for("pi-extensions.thinking-steps.state");

type TestMessage = {
	role: "assistant";
	timestamp: number;
	content: Array<
		| { type: "text"; text: string }
		| { type: "thinking"; thinking: string; redacted?: boolean }
		| { type: "toolCall"; id: string; name: string; args: Record<string, unknown> }
	>;
	stopReason?: "stop" | "toolUse" | "aborted" | "error" | "length";
	errorMessage?: string;
};

type RecordedChild = {
	constructor: { name: string };
	text?: string;
	paddingX?: number;
	paddingY?: number;
	children?: unknown[];
	child?: unknown;
};

const mockState = vi.hoisted(() => {
	class FakeContainer {
		children: unknown[] = [];

		addChild(child: unknown): void {
			this.children.push(child);
		}

		clear(): void {
			this.children = [];
		}

		render(width: number): string[] {
			return this.children.flatMap((child) => renderRecordedChild(child, width));
		}
	}

	function renderRecordedChild(child: unknown, width: number): string[] {
		if (!child || typeof child !== "object") return [];
		const value = child as { render?: (width: number) => string[]; text?: string; children?: unknown[]; child?: unknown };
		if (typeof value.render === "function") return value.render(width);
		if (typeof value.text === "string") return [value.text];
		if (Array.isArray(value.children)) return value.children.flatMap((nested) => renderRecordedChild(nested, width));
		if (value.child) return renderRecordedChild(value.child, width);
		return [];
	}

	class FakeAssistantMessageComponent extends FakeContainer {
		contentContainer = new FakeContainer();
		hideThinkingBlock: boolean;
		markdownTheme: unknown;
		hiddenThinkingLabel: string;
		lastMessage?: TestMessage;
		hasToolCalls = false;
		outputPad: number;

		constructor(message?: TestMessage, hideThinkingBlock = false, markdownTheme: unknown = {}, hiddenThinkingLabel = "Thinking...", outputPad = 1) {
			super();
			this.hideThinkingBlock = hideThinkingBlock;
			this.markdownTheme = markdownTheme;
			this.hiddenThinkingLabel = hiddenThinkingLabel;
			this.outputPad = outputPad;
			this.addChild(this.contentContainer);
			if (message) this.updateContent(message);
		}

		updateContent(message: TestMessage): void {
			this.lastMessage = message;
			this.contentContainer.clear();
			this.hasToolCalls = message.content.some((content) => content.type === "toolCall");
		}

		setHideThinkingBlock(hide: boolean): void {
			this.hideThinkingBlock = hide;
			if (this.lastMessage) this.updateContent(this.lastMessage);
		}

		setHiddenThinkingLabel(label: string): void {
			this.hiddenThinkingLabel = label;
			if (this.lastMessage) this.updateContent(this.lastMessage);
		}

		render(width: number): string[] {
			const lines = super.render(width);
			if (this.hasToolCalls || lines.length === 0) return lines;
			return [
				`${OSC133_ZONE_START}${lines[0]}`,
				...lines.slice(1, -1),
				`${OSC133_ZONE_END}${OSC133_ZONE_FINAL}${lines[lines.length - 1]}`,
			];
		}
	}

	return { FakeAssistantMessageComponent };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
	AssistantMessageComponent: mockState.FakeAssistantMessageComponent,
}));

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../test/stubs/pi-tui")>();

	class Markdown {
		constructor(
			readonly text = "",
			readonly paddingX = 0,
			readonly paddingY = 0,
			readonly markdownTheme?: unknown,
			readonly options?: unknown,
		) {}
	}

	class Text {
		constructor(readonly text = "", readonly paddingX = 0, readonly paddingY = 0) {}
	}

	class Spacer {
		constructor(readonly size = 1) {}
	}

	class Box {
		readonly children: unknown[];
		readonly child?: unknown;

		constructor(readonly paddingX = 0, readonly paddingY = 0, child?: unknown) {
			this.child = child;
			this.children = child === undefined ? [] : [child];
		}

		addChild(child: unknown): void {
			this.children.push(child);
		}
	}

	return { ...actual, Markdown, Text, Spacer, Box };
});

const releasePatches: Array<() => Promise<void>> = [];

function theme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};
}

function assistantMessage(content: TestMessage["content"], overrides: Partial<TestMessage> = {}): TestMessage {
	return {
		role: "assistant",
		timestamp: Date.now(),
		content,
		...overrides,
	};
}

async function retainPatch() {
	const mod = await import("../internal-patch.js");
	const release = await mod.retainThinkingStepsPatch(theme());
	releasePatches.push(release);
	return release;
}

function newComponent(outputPad: number) {
	return new mockState.FakeAssistantMessageComponent(undefined, false, {}, "Thinking...", outputPad);
}

function childrenOf(component: InstanceType<typeof mockState.FakeAssistantMessageComponent>): RecordedChild[] {
	return component.contentContainer.children as RecordedChild[];
}

function childrenDeep(child: unknown): RecordedChild[] {
	if (!child || typeof child !== "object") return [];
	const value = child as RecordedChild;
	return [
		value,
		...(value.children ?? []).flatMap(childrenDeep),
		...(value.child ? childrenDeep(value.child) : []),
	];
}

function firstChildNamed(component: InstanceType<typeof mockState.FakeAssistantMessageComponent>, name: string): RecordedChild | undefined {
	return childrenOf(component).flatMap(childrenDeep).find((child) => child.constructor.name === name);
}

function textLines(component: InstanceType<typeof mockState.FakeAssistantMessageComponent>): string[] {
	return childrenOf(component).flatMap(childrenDeep).flatMap((child) => typeof child.text === "string" ? [child.text] : []);
}

function originalMethods() {
	const prototype = mockState.FakeAssistantMessageComponent.prototype;
	return {
		updateContent: prototype.updateContent,
		setHideThinkingBlock: prototype.setHideThinkingBlock,
		setHiddenThinkingLabel: prototype.setHiddenThinkingLabel,
	};
}

afterEach(async () => {
	for (const release of releasePatches.splice(0).reverse()) {
		await release();
	}
	delete (globalThis as Record<PropertyKey, unknown>)[STATE_KEY];
	vi.resetModules();
	vi.restoreAllMocks();
});

describe("Pi 0.80.7 outputPad renderer contract", () => {
	it("honors outputPad for markdown, thinking, and errors", async () => {
		await retainPatch();
		const message = assistantMessage([
			{ type: "thinking", thinking: "Plan\n- inspect" },
			{ type: "text", text: "Final answer" },
		], { stopReason: "error", errorMessage: "boom" });

		for (const outputPad of [0, 1]) {
			const component = newComponent(outputPad);
			component.updateContent(message);

			const markdown = firstChildNamed(component, "Markdown");
			const error = textLines(component).find((line) => line === "Error: boom");
			const errorText = firstChildNamed(component, "Text");
			const thinkingBox = childrenOf(component).find((child) => child.constructor.name === "Box" && childrenDeep(child).some((nested) => nested.constructor.name === "ThinkingStepsComponent"));

			expect(markdown?.paddingX).toBe(outputPad);
			expect(markdown?.paddingY).toBe(0);
			expect(error).toBe("Error: boom");
			expect(errorText?.paddingX).toBe(outputPad);
			expect(errorText?.paddingY).toBe(0);
			expect(thinkingBox?.paddingX).toBe(outputPad);
			expect(thinkingBox?.paddingY).toBe(0);
		}
	});
});

describe("Pi 0.80.7 hasToolCalls renderer contract", () => {
	it("updates hasToolCalls so inherited OSC-133 rendering stays correct", async () => {
		await retainPatch();
		const component = newComponent(1);

		component.updateContent(assistantMessage([
			{ type: "thinking", thinking: "Need tool" },
			{ type: "toolCall", id: "tool-1", name: "read", args: {} },
		]));

		expect(component.hasToolCalls).toBe(true);
		expect(component.render(80).join("\n")).not.toContain(OSC133_ZONE_START);

		component.updateContent(assistantMessage([
			{ type: "thinking", thinking: "No tool" },
			{ type: "text", text: "Done" },
		]));

		expect(component.hasToolCalls).toBe(false);
		const rendered = component.render(80).join("\n");
		expect(rendered).toContain(OSC133_ZONE_START);
		expect(rendered).toContain(OSC133_ZONE_END + OSC133_ZONE_FINAL);
	});
});

describe("Pi 0.80.7 length-stop renderer contract", () => {
	it("renders Pi 0.80.7 length-stop error exactly", async () => {
		await retainPatch();

		for (const content of [
			[{ type: "text" as const, text: "Partial answer" }],
			[
				{ type: "text" as const, text: "Partial answer" },
				{ type: "toolCall" as const, id: "tool-1", name: "read", args: {} },
			],
		]) {
			const component = newComponent(1);
			component.updateContent(assistantMessage(content, { stopReason: "length" }));

			expect(textLines(component)).toContain(MAX_TOKENS_ERROR);
		}
	});
});

describe("Thinking Steps patch refcount contract", () => {
	it("restores original prototype methods after final release", async () => {
		const before = originalMethods();
		const firstRelease = await retainPatch();
		const patched = originalMethods();

		expect(patched.updateContent).not.toBe(before.updateContent);
		expect(patched.setHideThinkingBlock).not.toBe(before.setHideThinkingBlock);
		expect(patched.setHiddenThinkingLabel).not.toBe(before.setHiddenThinkingLabel);

		await firstRelease();
		expect(originalMethods()).toEqual(before);

		const releaseA = await retainPatch();
		const releaseB = await (await import("../internal-patch.js")).retainThinkingStepsPatch(theme());
		const patchedTwice = originalMethods();
		await releaseA();
		expect(originalMethods()).toEqual(patchedTwice);
		await releaseB();
		expect(originalMethods()).toEqual(before);
	});
});
