// Run with native Pi to exercise its assistant Markdown transformers:
// PI_CODING_AGENT_DIR=$(mktemp -d) pi --no-extensions -e ./test/integration/thinking-steps-mermaid.check.ts --list-models
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { AssistantMessageComponent, createAgentSession, DefaultResourceLoader, InteractiveMode, SessionManager, SettingsManager, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { retainThinkingStepsPatch } from "../../extensions/thinking-steps/internal-patch.js";
import { ThinkingStepsComponent } from "../../extensions/thinking-steps/render.js";

type Transformer = (markdown: string, context: { messageType: string; isStreaming: boolean; availableWidth: number }) => string;
type RenderedAssistant = {
	updateContent(message: AssistantMessage, isStreaming: boolean): void;
	render(width: number): string[];
	isStreaming?: boolean;
	contentContainer: { children: Array<{ constructor: { name: string }; children?: unknown[] }> };
};

export default async function () {
	let release: (() => Promise<void>) | undefined;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let exitCode = 1;
	try {
		initTheme("dark");
		const resourceLoader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR!, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
		await resourceLoader.reload();
		({ session } = await createAgentSession({ resourceLoader, sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory() }));
		// Only construct the native UI: no terminal start and no model request.
		const NativeMode = InteractiveMode as unknown as new (host: object) => { mermaidMarkdownTransformer: Transformer };
		const mode = new NativeMode({ session, setBeforeSessionInvalidate() {}, setRebindSession() {} });
		assert.equal(typeof mode.mermaidMarkdownTransformer, "function", "native Mermaid renderer required");
		const theme = { fg: (_color: string, text: string) => text, bold: getMarkdownTheme().bold };
		release = await retainThinkingStepsPatch(theme);
		const NativeAssistant = AssistantMessageComponent as unknown as new (...args: unknown[]) => RenderedAssistant;
		const contexts: Parameters<Transformer>[1][] = [];
		const recordContext: Transformer = (markdown, context) => {
			contexts.push(context);
			return markdown;
		};
		const component = new NativeAssistant(undefined, false, getMarkdownTheme(), "Thinking...", 1, [recordContext, mode.mermaidMarkdownTransformer]);
		const message: AssistantMessage = {
			role: "assistant", api: "anthropic-messages", provider: "check", model: "check", timestamp: 1, stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			content: [{ type: "thinking", thinking: "Plan: show the tiny diagram." }, { type: "text", text: "```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```" }],
		};
		component.updateContent(message, true);
		const output = stripVTControlCharacters(component.render(80).join("\n"));
		assert.match(output, /Start/);
		assert.match(output, /Done/);
		assert.match(output, /[┌┐└┘╭╮╰╯]/, "diagram node borders");
		assert.doesNotMatch(output, /graph TD|A\[Start\]|-->/, "must render the diagram, not Mermaid source");
		assert.ok(component.contentContainer.children.some((child) => child.children?.some((nested) => nested instanceof ThinkingStepsComponent)), "custom thinking component retained");
		console.log(output);
		for (const content of [
			[{ type: "text", text: "Answer" }],
			[{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }],
			[],
			[{ type: "thinking", thinking: "" }],
			[{ type: "thinking", thinking: " \n\t " }],
			[{ type: "thinking", thinking: " \n " }, { type: "text", text: "Answer" }],
		] satisfies AssistantMessage["content"][]) {
			const hasText = content.some((block) => block.type === "text");
			for (const isStreaming of [true, false]) {
				contexts.length = 0;
				component.updateContent({ ...message, content }, isStreaming);
				assert.equal(component.isStreaming, isStreaming, "native streaming state preserved");
				const rendered = stripVTControlCharacters(component.render(80).join("\n"));
				assert.doesNotMatch(rendered, /Thinking/, "empty thinking stays silent");
				assert.ok(!component.contentContainer.children.some((child) => child.children?.some((nested) => nested instanceof ThinkingStepsComponent)));
				assert.equal(component.contentContainer.children.filter((child) => child.constructor.name === "Spacer").length, hasText ? 1 : 0);
				if (hasText) {
					assert.equal(component.contentContainer.children[0]?.constructor.name, "Spacer");
					assert.match(rendered, /^\s*\n +Answer/, "normal leading text spacing retained");
					assert.ok(contexts.length > 0, "assistant transformer invoked");
					for (const context of contexts) {
						assert.equal(context.messageType, "assistant");
						assert.equal(context.isStreaming, isStreaming);
						assert.equal(context.availableWidth, 78);
					}
				} else {
					assert.equal(rendered, "", "no empty-panel spacing");
				}
			}
		}
		component.updateContent(message, false);
		const completed = stripVTControlCharacters(component.render(80).join("\n"));
		assert.match(completed, /Start/);
		assert.match(completed, /Done/);
		assert.doesNotMatch(completed, /graph TD|A\[Start\]|-->/);
		console.log("PASS: native Mermaid diagram, silent empty thinking, and streaming transformer context");
		exitCode = 0;
	} catch (error) {
		console.error(error);
	} finally {
		await release?.();
		session?.dispose();
	}
	process.exit(exitCode);
}
