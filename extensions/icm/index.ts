import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger, initDebugFromEnv } from "../lib/logger.js";

// Bound on the calls a turn waits for (`icm hook start` / `icm hook prompt`, ~40 ms when healthy).
const HOOK_TIMEOUT_MS = 2000;
// Enqueue runs off the turn path; it only writes a queue row and never loads the embedding model.
const ENQUEUE_TIMEOUT_MS = 10_000;
// Mirrors rtk-ai/icm plugins/opencode-icm.ts: capture one tool output per EXTRACT_EVERY calls, and
// drain the queue (one fastembed model load) once per DRAIN_EVERY enqueues.
const EXTRACT_EVERY = 10;
const DRAIN_EVERY = 10;
const NOISE_TOOLS = new Set(["edit", "write"]);

interface SessionState {
	icm: string;
	sessionId: string;
	wakeUp: Promise<string>;
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
		state = { icm, sessionId, wakeUp, toolCalls: 0, enqueues: 0 };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const current = state;
		if (!current) return;
		const wakeUp = await current.wakeUp;
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
		if (state.toolCalls < EXTRACT_EVERY) return;
		state.toolCalls = 0;

		const output = textOf(event.content);
		if (output.length < 20) return;
		state.enqueues++;
		const drain = state.enqueues >= DRAIN_EVERY;
		if (drain) state.enqueues = 0;
		enqueue(state, ctx, output.slice(0, 8000), drain);
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
		// Compaction is a natural flush point: queue the conversation slice and drain everything.
		state.enqueues = 0;
		enqueue(state, ctx, text, true);
	});
}
