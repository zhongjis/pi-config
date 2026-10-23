import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger, initDebugFromEnv } from "../lib/logger.js";
import { resolveToolModelCandidates } from "../lib/tool-models.js";

// Bound on the calls a turn waits for (`icm hook start` / `icm hook prompt`, ~40 ms when healthy).
const HOOK_TIMEOUT_MS = 2000;
// Enqueue runs off the turn path; it only writes a queue row and never loads the embedding model.
const ENQUEUE_TIMEOUT_MS = 10_000;
// Mirrors rtk-ai/icm plugins/opencode-icm.ts: capture one tool output per EXTRACT_EVERY calls, and
// drain the queue (one fastembed model load) once per DRAIN_EVERY enqueues. Native mode uses icm's
// own `[extraction] extract_every` instead, the cadence its Claude Code hook samples at.
const EXTRACT_EVERY = 10;
const DRAIN_EVERY = 10;
const NOISE_TOOLS = new Set(["edit", "write"]);
// Native extraction: Pi's model stands in for icm's summarizer, which has no Pi provider.
const EXTRACT_TOOL_KEY = "icm.extract";
const EXTRACT_TIMEOUT_MS = 60_000;
// `icm store` loads the embedding model per call.
const STORE_TIMEOUT_MS = 30_000;

interface SessionState {
	icm: string;
	sessionId: string;
	wakeUp: Promise<string>;
	/** Pi extracts natively when icm's summarizer is `auto`; otherwise icm's queue does. */
	native: Promise<boolean>;
	/** Tool outputs per capture: EXTRACT_EVERY, or icm's `extract_every` once native mode is confirmed. */
	extractEvery: number;
	/** Tail of the native extraction chain; captures run one at a time. */
	extracting: Promise<void>;
	project?: Promise<string>;
	toolCalls: number;
	enqueues: number;
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function findIcm(): string | undefined {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.map((dir) => join(dir, "icm"))
		.find(isExecutable);
}

function run(file: string, args: string[], cwd: string, input: string, timeout: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(file, args, { cwd, timeout, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${basename(file)} ${args.join(" ")}: ${error.message}${stderr.trim() ? ` (${stderr.trim()})` : ""}`));
			else resolve(stdout.trim());
		});
		child.stdin?.on("error", reject);
		child.stdin?.end(input);
	});
}

function debug(ctx: ExtensionContext, event: string, error: unknown): void {
	const detail = error instanceof Error ? error.message : String(error);
	try {
		createLogger(ctx, "icm").debug(event, detail);
	} catch {
		// A captured ctx goes stale after a session switch; keep the diagnostic on the console.
		console.debug(`[icm] ${event}`, detail);
	}
}

// ponytail: mirrors icm-core project.rs project_from_path (origin repo name, then main worktree
// dir, then cwd basename) so queued facts land under the project `icm hook prompt` filters on.
// Replace with an icm CLI call if icm ever exposes project detection.
async function resolveProject(cwd: string): Promise<string> {
	const git = (args: string[]) => run("git", ["-C", cwd, ...args], cwd, "", HOOK_TIMEOUT_MS).catch(() => "");
	const remote = (await git(["remote", "get-url", "origin"])).replace(/\/+$/, "");
	const fromRemote = remote.split("/").pop()?.split(":").pop()?.replace(/(\.git)+$/, "");
	if (fromRemote) return fromRemote;
	const commonDir = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	return basename(commonDir ? dirname(commonDir) : cwd) || "project";
}

/**
 * Native cadence from `icm config`: its `[extraction] extract_every` when extraction is enabled and
 * `[extraction.summarizer] provider = auto`, else undefined (icm's queue extracts).
 * ponytail: line-scans icm's printed config (no TOML dependency installed); replace with a
 * machine-readable icm config query if icm ever exposes one.
 */
function nativeExtractEvery(config: string): number | undefined {
	let section = "";
	let enabled = false;
	let provider = "";
	let every = Number.NaN;
	for (const raw of config.split("\n")) {
		const line = raw.trim();
		const header = /^\[(.+)\]$/.exec(line);
		if (header) {
			section = header[1];
			continue;
		}
		const [key, value] = line.split(/\s*=\s*/, 2);
		if (section === "extraction" && key === "enabled") enabled = value === "true";
		if (section === "extraction" && key === "extract_every") every = Number(value);
		if (section === "extraction.summarizer" && key === "provider") provider = value.replace(/^"|"$/g, "");
	}
	if (!enabled || provider !== "auto") return undefined;
	// icm config prints extract_every with its default applied; 3 is that default if a build omits it.
	return Number.isInteger(every) && every > 0 ? every : 3;
}

// ponytail: extractPrompt and parseFacts copy icm main.rs build_extract_prompt and reply_line (v0.11.5)
// so native facts match icm-extracted ones; resync on icm bumps, or call icm if it ever exposes them.
function extractPrompt(source: string, project: string, text: string): string {
	return [
		"From the tool outputs below, extract durable facts that an AI agent should remember across sessions: architecture decisions, resolved errors, user preferences, project-specific context.",
		"",
		"Output format: one fact per line, prefixed with `- `. Each fact must be a complete, standalone sentence — no pronouns referring to missing context. Skip routine noise (file listings, build progress, git status). If nothing durable is present, output exactly `- (none)`.",
		"",
		`=== tool=${source} project=${project} ===`,
		text,
	].join("\n");
}

const BULLET = /^(?:[-*•+–]\s|\d{1,3}[.)] )/;
const NOTHING = /^(?:n\/a$|none(?:$|[ )—])|no durable|nothing durable|no facts|no new facts|nothing to extract|nothing worth|i don't see|i do not see)/;

/** Facts from a reply: list items only, minus items saying nothing was found (icm main.rs reply_line). */
function parseFacts(reply: string): string[] {
	return reply.split("\n").flatMap((raw) => {
		const line = raw.trim();
		if (!BULLET.test(line)) return [];
		const item = line.replace(BULLET, "").trim();
		const plain = item.replace(/^[*`_(). ]+|[*`_(). ]+$/g, "").toLowerCase().replace(/[*`_]/g, "");
		return !plain || NOTHING.test(plain) ? [] : [item];
	});
}

/** Extract facts with Pi's model and store them with `icm store`; never touches icm's shared queue. */
async function extractNative(state: SessionState, ctx: ExtensionContext, source: string, text: string): Promise<void> {
	const cwd = ctx.cwd;
	const { candidates, chain } = resolveToolModelCandidates(ctx, EXTRACT_TOOL_KEY);
	state.project ??= resolveProject(cwd);
	const project = await state.project;
	const prompt = extractPrompt(source, project, text);
	let reply: string | undefined;
	for (const { model, thinkingLevel } of candidates) {
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) continue;
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
				{ reasoningEffort: thinkingLevel, signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS) },
			);
			if (response.stopReason !== "stop") throw new Error(response.errorMessage ?? `stopReason ${response.stopReason}`);
			reply = response.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
			break;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			debug(ctx, "native extract failed", `${model.provider}/${model.id}: ${detail}`);
		}
	}
	if (reply === undefined) {
		debug(ctx, "native extract skipped", `no usable model (tried: ${chain ?? "none"})`);
		return;
	}
	// Sequential: each `icm store` writes the same SQLite store. The error names the fact in argv; keep it out of logs.
	for (const fact of parseFacts(reply)) {
		await run(state.icm, ["store", "-t", `context-${project}`, "-c", fact], cwd, "", STORE_TIMEOUT_MS).catch(() =>
			debug(ctx, "store failed", `icm store -t context-${project}`),
		);
	}
}

/** Hand captured text to Pi's model (native, one capture at a time) or icm's queue, off the turn path. */
function capture(state: SessionState, ctx: ExtensionContext, source: string, text: string, drain: boolean): void {
	void state.native
		.then((native) => {
			if (!native) return enqueue(state, ctx, text, drain);
			// Serial: each extraction ends in `icm store` calls that load the embedding model.
			state.extracting = state.extracting
				.then(() => extractNative(state, ctx, source, text))
				.catch((error) => debug(ctx, "capture failed", error));
		})
		.catch((error) => debug(ctx, "capture failed", error));
}

/** Queue text for extraction without blocking the caller; optionally drain the queue detached. */
function enqueue(state: SessionState, ctx: ExtensionContext, text: string, drain: boolean): void {
	const cwd = ctx.cwd;
	state.project ??= resolveProject(cwd);
	void state.project
		.then((project) => run(state.icm, ["extract", "--enqueue", "-p", project], cwd, text, ENQUEUE_TIMEOUT_MS))
		.then(() => {
			if (!drain) return;
			const child = spawn(state.icm, ["extract-pending", "--limit", "30"], { cwd, detached: true, stdio: "ignore" });
			child.on("error", (error) => debug(ctx, "drain failed", error));
			child.unref();
		})
		.catch((error) => debug(ctx, "enqueue failed", error));
}

function textOf(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/** Automatic icm memory lifecycle: wake-up pack, per-prompt recall, and background extraction. */
export default function icmExtension(pi: ExtensionAPI): void {
	initDebugFromEnv();
	let state: SessionState | undefined;

	pi.on("session_start", (_event, ctx) => {
		const icm = findIcm();
		state = undefined;
		if (!icm) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const payload = JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, cwd: ctx.cwd });
		const wakeUp = run(icm, ["hook", "start"], ctx.cwd, payload, HOOK_TIMEOUT_MS).catch((error) => {
			debug(ctx, "wake-up failed", error);
			return "";
		});
		const next: SessionState = {
			icm,
			sessionId,
			wakeUp,
			native: Promise.resolve(false),
			extractEvery: EXTRACT_EVERY,
			extracting: Promise.resolve(),
			toolCalls: 0,
			enqueues: 0,
		};
		next.native = run(icm, ["config"], ctx.cwd, "", HOOK_TIMEOUT_MS)
			.then((config) => {
				const every = nativeExtractEvery(config);
				if (every !== undefined) next.extractEvery = every;
				return every !== undefined;
			})
			.catch((error) => {
				debug(ctx, "config check failed", error);
				return false;
			});
		state = next;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const current = state;
		if (!current) return;
		// Native mode also settles the capture cadence; both icm calls ran in parallel since session start.
		const [wakeUp] = await Promise.all([current.wakeUp, current.native]);
		if (wakeUp) event.systemPromptOptions.sections.icm = wakeUp;
		if (event.messageType !== "user" || !event.prompt.trim()) return;

		const payload = JSON.stringify({
			hook_event_name: "UserPromptSubmit",
			session_id: current.sessionId,
			cwd: ctx.cwd,
			prompt: event.prompt,
		});
		const recalled = await run(current.icm, ["hook", "prompt"], ctx.cwd, payload, HOOK_TIMEOUT_MS).catch((error) => {
			debug(ctx, "prompt recall failed", error);
			return "";
		});
		if (!recalled) return;
		return { message: { customType: "icm-recall", content: recalled, display: false } };
	});

	pi.on("tool_result", (event, ctx) => {
		if (!state || NOISE_TOOLS.has(event.toolName) || event.toolName.startsWith("icm")) return;
		// The agent reads and writes memory through the icm CLI; re-extracting that output loops.
		if (event.toolName === "bash" && /^\s*icm\b/.test(String(event.input.command ?? ""))) return;

		state.toolCalls++;
		if (state.toolCalls < state.extractEvery) return;
		state.toolCalls = 0;

		const output = textOf(event.content);
		if (output.length < 20) return;
		state.enqueues++;
		const drain = state.enqueues >= DRAIN_EVERY;
		if (drain) state.enqueues = 0;
		// Keep the tail, as icm's post hook does: test, build and error results land at the end.
		capture(state, ctx, event.toolName, output.slice(-8000), drain);
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (!state) return;
		const { messagesToSummarize, turnPrefixMessages } = event.preparation;
		const text = [...messagesToSummarize, ...turnPrefixMessages]
			.filter((message) => message.role === "assistant")
			.slice(-20)
			.map((message) => textOf(message.content))
			.join("\n")
			.slice(-4000);
		if (text.length < 50) return;
		// Compaction is a natural flush point: capture the conversation slice (and drain icm's queue when not native).
		state.enqueues = 0;
		capture(state, ctx, "compaction", text, true);
	});
}
