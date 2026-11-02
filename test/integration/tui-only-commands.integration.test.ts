import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestSession, type TestSession } from "./helpers/faux-session.js";

// Terminal-only commands register from a `tui` session_start (extensions/lib/mode.ts),
// so RPC clients such as T3 Code never list them.
const ROOT = resolve(__dirname, "../..");
const TUI_ONLY_EXTENSIONS = [
	...["thinking-steps", "tools", "diff"].map((name) => resolve(ROOT, "extensions", name, "index.ts")),
	resolve(ROOT, "extensions", "subagents", "src", "index.ts"),
];
const TUI_ONLY_COMMANDS = ["thinking-steps", "tools", "diff", "agents", "agent-monitor", "agent-graph-replay"];

type RpcLine = { id?: string; type?: string; command?: string; success?: boolean; data?: { commands?: Array<{ name: string }> } };

/** Run real `pi --mode rpc` and return its `get_commands` reply; undefined when `pi` is not on PATH. */
function rpcGetCommands(): Promise<RpcLine | undefined> {
	return new Promise((resolvePromise, reject) => {
		const args = ["--mode", "rpc", "--no-session", "-ne", ...TUI_ONLY_EXTENSIONS.flatMap((path) => ["-e", path])];
		// Inherits the real agent dir: non-interactive pi exits before reading stdin without an authed model.
		const child = spawn("pi", args, { cwd: ROOT, env: { ...process.env, PI_OFFLINE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (error: Error | undefined, reply?: RpcLine) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill();
			if (error) reject(error);
			else resolvePromise(reply);
		};
		const timer = setTimeout(() => finish(new Error(`pi --mode rpc timed out\nstderr: ${stderr}`)), 20_000);
		child.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") finish(undefined);
			else finish(error);
		});
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		// EPIPE when pi is missing or exits early; the exit/error handlers report it.
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") finish(error);
		});
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
			const lines = stdout.split("\n");
			stdout = lines.pop() ?? ""; // keep the unfinished last line for the next chunk
			for (const line of lines) {
				if (!line.trim().startsWith("{")) continue;
				const parsed = JSON.parse(line) as RpcLine;
				if (parsed.id === "tui-only" && parsed.type === "response") finish(undefined, parsed);
			}
		});
		child.on("exit", (code) => finish(new Error(`pi --mode rpc exited (${code}) before replying\nstderr: ${stderr}`)));
		child.stdin.write(`${JSON.stringify({ type: "get_commands", id: "tui-only" })}\n`);
	});
}

describe("terminal-only commands", () => {
	const sessions: TestSession[] = [];

	afterEach(async () => {
		for (const testSession of sessions) {
			await testSession.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			testSession.dispose();
		}
		sessions.length = 0;
	});

	it("registers commands and alt+t in tui sessions", async () => {
		const testSession = await createTestSession({ extensions: TUI_ONLY_EXTENSIONS, mode: "tui" });
		sessions.push(testSession);
		const runner = testSession.session.extensionRunner;

		const names = runner.getRegisteredCommands().map((command: { name: string }) => command.name);
		expect(names).toEqual(expect.arrayContaining(TUI_ONLY_COMMANDS));
		expect([...runner.getShortcuts({}).keys()]).toContain("alt+t");
	});

	it("are absent from real RPC get_commands", async (context) => {
		const reply = await rpcGetCommands();
		if (!reply) context.skip();

		expect(reply).toMatchObject({ type: "response", command: "get_commands", success: true });
		const names = reply?.data?.commands?.map((command) => command.name) ?? [];
		for (const name of TUI_ONLY_COMMANDS) expect(names).not.toContain(name);
	});
});
