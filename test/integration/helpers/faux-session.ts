/**
 * faux-session.ts — repo-local drop-in replacement for
 * `@marcfargas/pi-test-harness` `createTestSession` + the `when`/`calls`/`says`
 * playbook DSL, rebuilt for pi 0.83.
 *
 * WHY THIS EXISTS
 * ---------------
 * The upstream harness drives scripted model responses by overriding
 * `session.agent.streamFn`. Pi 0.83 no longer routes turns through
 * `agent.streamFn`, so those playbooks are never consumed (tests fail with
 * "Playbook not fully consumed … Consumed 0 of N"). Pi 0.83's native way to
 * inject deterministic model responses is the pi-ai **faux provider** feeding a
 * real `ModelRuntime`.
 *
 * This module ports the upstream harness verbatim (event collection, tool
 * wrapping, mock UI, extension loading, diagnostics), changing ONLY the model
 * driver: instead of `agent.streamFn = playbookStreamFn`, `run()` maps each
 * playbook action to a faux response step and feeds them via
 * `faux.setResponses(...)`. The real agent loop + real extension hooks then run
 * exactly as in production.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxModelRuntime, type FauxModelRuntime } from "./faux-runtime.js";
import { buildFauxSteps, createPlaybookState, type PlaybookState } from "./playbook-dsl.js";
import { interceptToolExecution } from "./mock-tools.js";
import { createMockUIContext } from "./mock-ui.js";
import { createEventCollector } from "./events.js";
import { formatPlaybookDiagnostic } from "./diagnostics.js";
import type {
	TestSessionOptions,
	TestSession,
	Turn,
	ToolCallRecord,
} from "./types.js";

// Re-export the DSL builders + types so tests can import everything the upstream
// `@marcfargas/pi-test-harness` module exposed from this single entrypoint.
export { when, calls, says } from "./playbook-dsl.js";
export type {
	TestSession,
	TestSessionOptions,
	TestEvents,
	ToolCallRecord,
	ToolResultRecord,
	UICallRecord,
	MockToolHandler,
	MockUIConfig,
	Turn,
	PlaybookAction,
} from "./types.js";
export { ToolBlockedError } from "./mock-tools.js";

export async function createTestSession(options: TestSessionOptions = {}): Promise<TestSession> {
	const propagateErrors = options.propagateErrors ?? true;
	const ownsTmpDir = !options.cwd;
	const cwd = options.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-faux-harness-"));

	// Ensure cwd exists
	if (!fs.existsSync(cwd)) {
		fs.mkdirSync(cwd, { recursive: true });
	}

	// Native pi-ai faux runtime (auth-free, deterministic). Created FIRST so the
	// session is built against the faux model + runtime.
	const faux: FauxModelRuntime = await createFauxModelRuntime({
		models: [{ id: "faux-1", contextWindow: 200_000 }],
	});

	// Build resource loader with extensions
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd, // Use cwd as agent dir to avoid touching real ~/.pi
		settingsManager,
		additionalExtensionPaths: [
			path.resolve(__dirname, "faux-compat-provider.ts"),
			...(options.extensions?.map((p) => path.resolve(cwd, p)) ?? []),
		],
		extensionFactories: options.extensionFactories,
		systemPromptOverride: options.systemPrompt ? () => options.systemPrompt! : undefined,
	});
	await loader.reload();

	// Create real session driven by the faux provider (never hits the network).
	const { session, extensionsResult } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model: faux.model,
		modelRuntime: faux.modelRuntime,
		sessionManager: SessionManager.inMemory(),
		settingsManager,
		resourceLoader: loader,
	});

	// Override getApiKey to bypass real auth checks (on both agent and session).
	// Harmless with faux (which is auth-free), but kept for parity with upstream
	// and any code paths that still consult these.
	(session.agent as any).getApiKey = async () => "test-key";

	// Check for extension load errors
	if (extensionsResult?.errors?.length > 0) {
		session.dispose();
		faux.dispose();
		if (ownsTmpDir && fs.existsSync(cwd)) {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
		const errors = extensionsResult.errors
			.map((e: { path: string; error: unknown }) => `  ${e.path}: ${e.error}`)
			.join("\n");
		throw new Error(`Extension load errors:\n${errors}`);
	}

	// Event collection
	const events = createEventCollector();
	let currentStep = 0;

	// Subscribe to session events (ported verbatim — model-driver-independent).
	session.subscribe((event: AgentSessionEvent) => {
		events.all.push(event);

		// Collect tool call events
		if (event.type === "tool_execution_start") {
			const record: ToolCallRecord = {
				step: currentStep,
				toolName: (event as any).toolName,
				input: (event as any).args ?? {},
				blocked: false,
			};
			events.toolCalls.push(record);
		}

		if (event.type === "tool_execution_end") {
			const resultText = (event as any).result?.content
				?.filter((c: any) => c.type === "text")
				?.map((c: any) => c.text)
				?.join("\n") ?? "";

			if ((event as any).isError) {
				// Check if this was a block (look at the most recent tool call)
				const lastCall = events.toolCalls[events.toolCalls.length - 1];
				if (lastCall && lastCall.toolName === (event as any).toolName) {
					// Detect block via result text. We cannot use isBlockedError() here
					// because the AgentSessionEvent only carries the serialized result
					// content — not the original Error object. Pi does not yet export a
					// typed block error, so message-string matching is the only option
					// at this layer. Keep in sync with isBlockedError() in mock-tools.ts.
					if (resultText.includes("blocked") || resultText.includes("Plan mode")) {
						lastCall.blocked = true;
						lastCall.blockReason = resultText;
					}
				}
			}

			// Recent pi versions can block a tool before the wrapped tool.execute()
			// runs. In that path mock-tools.ts cannot record the result itself, so
			// mirror the serialized session event if no wrapper record exists yet.
			if (!events.toolResults.some((r) => r.toolCallId === (event as any).toolCallId)) {
				events.toolResults.push({
					step: currentStep,
					toolName: (event as any).toolName,
					toolCallId: (event as any).toolCallId,
					text: resultText,
					content: (event as any).result?.content ?? [],
					isError: (event as any).isError,
					details: (event as any).result?.details,
					mocked: false,
				});
			}
		}

		// Collect messages
		if (event.type === "message_end") {
			events.messages.push((event as any).message);
		}
	});

	// Playbook state (initialized on run())
	let playbookState: PlaybookState | null = null;

	// Mock UI context
	const mockUI = createMockUIContext(options.mockUI, events.ui);

	// Inject mock UI context via bindExtensions
	await session.bindExtensions({
		uiContext: mockUI,
		onError: (err: { event: string; error: unknown }) => {
			console.error(`[faux-harness] Extension error: ${err.event} — ${err.error}`);
		},
	});
	const modelRegistry = (session as any).extensionRunner.getModelRegistry();
	modelRegistry.getApiKey = async () => "test-key";
	modelRegistry.getApiKeyForProvider = async () => "test-key";
	modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-key", headers: {} });
	modelRegistry.hasConfiguredAuth = () => true;
	modelRegistry.isUsingOAuth = () => false;

	// Capture original tools before any wrapping — used in run() to avoid double-wrap
	const originalTools: AgentTool[] = [...((session.agent as any).state.tools as AgentTool[])];

	const testSession: TestSession = {
		session,
		cwd,
		events,

		get playbook() {
			return {
				consumed: playbookState?.consumed ?? 0,
				remaining: playbookState?.remaining ?? 0,
			};
		},

		async run(...turns: Turn[]): Promise<void> {
			// Build the faux response queue from the flattened playbook.
			const state = createPlaybookState();
			playbookState = state;
			const steps = buildFauxSteps(turns, state, (session as any).id, options.fauxResponseRouter);

			// Feed the deterministic responses to the faux provider. This REPLACES
			// the upstream `agent.streamFn = playbookStreamFn` — pi 0.83 drives the
			// turn through the real ModelRuntime → faux provider instead.
			faux.faux.setResponses(steps);
			(session.agent as any).getApiKey = () => "test-key";

			// Always wrap tools for event collection; if no mocks configured, pass empty map
			const effectiveMockTools = options.mockTools ?? {};
			const runner = (session as any).extensionRunner;
			const interceptedTools = interceptToolExecution(
				originalTools,
				effectiveMockTools,
				events.toolResults,
				state,
				propagateErrors,
				runner,
			);
			const agent = session.agent as any;
			if (typeof agent.setTools === "function") {
				agent.setTools(interceptedTools);
			} else {
				agent.state.tools = interceptedTools;
			}

			// Run each turn
			for (const turn of turns) {
				currentStep = state.consumed;
				await session.prompt(turn.prompt);
				await (session.agent as any).waitForIdle?.();
			}

			// Auto-assert: playbook fully consumed
			if (state.remaining > 0) {
				// Collect remaining actions for diagnostics
				const allActions = turns.flatMap((t) => t.actions);
				const remaining = allActions.slice(state.consumed);
				const diagnostic = formatPlaybookDiagnostic("remaining", state, remaining);
				throw new Error(diagnostic);
			}
		},

		/**
		 * Dispose the test session, faux runtime, and the temp directory (if owned).
		 */
		dispose(): void {
			session.dispose();
			faux.dispose();
			if (ownsTmpDir && fs.existsSync(cwd)) {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		},
	};

	return testSession;
}
