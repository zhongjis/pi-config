import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import icmExtension from "../index.js";

// Fake icm: logs "<argv>\t<stdin>" one record per call, answers hook start/prompt with canned text.
const FAKE_ICM = `#!/bin/sh
input=$(cat)
case "$1 $2" in
  "hook prompt") [ -n "$FAKE_ICM_SLOW_PROMPT" ] && sleep 5 ;;
  "extract --enqueue") [ -n "$FAKE_ICM_SLOW_ENQUEUE" ] && sleep 1 ;;
esac
printf '%s\\t%s\\n' "$*" "$(printf '%s' "$input" | tr '\\n' ' ')" >> "$FAKE_ICM_LOG"
case "$1 $2" in
  "hook start") printf '# ICM Wake-up\\n- wake fact\\n' ;;
  "hook prompt") printf 'recalled: prompt fact\\n' ;;
esac
`;

const ENV_KEYS = ["PATH", "FAKE_ICM_LOG", "FAKE_ICM_SLOW_PROMPT", "FAKE_ICM_SLOW_ENQUEUE"] as const;
let bin: string;
let dir: string;
let savedEnv: Record<string, string | undefined>;

function calls(): string[] {
	const log = join(dir, "icm.log");
	return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

async function setup(withIcm: boolean) {
	if (withIcm) {
		process.env.PATH = [bin, savedEnv.PATH].join(delimiter);
	} else {
		process.env.PATH = ["/usr/bin", "/bin"].join(delimiter);
	}
	const mock = createMockPi();
	icmExtension(mock.pi as never);
	const ctx = { ...createMockContext(), cwd: dir };
	const handler = (name: string) => (mock.lifecycleHandlers.get(name) ?? [])[0];
	await handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
	const beforeAgentStart = async (prompt: string) => {
		const event = { type: "before_agent_start", messageType: "user", prompt, systemPromptOptions: { sections: {} as Record<string, string> } };
		const result = await handler("before_agent_start")(event, ctx);
		return { sections: event.systemPromptOptions.sections, result };
	};
	const toolResult = (text: string, toolName = "read", input: Record<string, unknown> = {}) =>
		handler("tool_result")({ type: "tool_result", toolName, toolCallId: "c", input, content: [{ type: "text", text }], isError: false }, ctx);
	const compact = (messages: unknown[]) =>
		handler("session_before_compact")({ type: "session_before_compact", preparation: { messagesToSummarize: messages, turnPrefixMessages: [] } }, ctx);
	return { beforeAgentStart, toolResult, compact };
}

beforeAll(() => {
	bin = mkdtempSync(join(tmpdir(), "icm-bin-"));
	writeFileSync(join(bin, "icm"), FAKE_ICM);
	chmodSync(join(bin, "icm"), 0o755);
	// Warm up: macOS scans a new executable on first exec, which can exceed the hook timeout.
	execFileSync(join(bin, "icm"), ["--version"], { input: "", env: { ...process.env, FAKE_ICM_LOG: "/dev/null" } });
});

afterAll(() => rmSync(bin, { recursive: true, force: true }));

beforeEach(() => {
	savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	dir = mkdtempSync(join(tmpdir(), "icm-ext-"));
	process.env.FAKE_ICM_LOG = join(dir, "icm.log");
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("icm extension", () => {
	it("is a complete no-op when icm is not on PATH", async () => {
		const { beforeAgentStart, toolResult, compact } = await setup(false);
		const { sections, result } = await beforeAgentStart("what did we decide?");
		expect(sections).toStrictEqual({});
		expect(result).toBeUndefined();
		for (let i = 0; i < 20; i++) expect(toolResult("x".repeat(100))).toBeUndefined();
		expect(compact([{ role: "assistant", content: [{ type: "text", text: "y".repeat(100) }] }])).toBeUndefined();
	});

	it("injects the wake-up pack as a prompt section and recalled context as a hidden message", async () => {
		const { beforeAgentStart } = await setup(true);
		const first = await beforeAgentStart("what did we decide about MCP?");
		expect(first.sections.icm).toBe("# ICM Wake-up\n- wake fact");
		expect(first.result).toStrictEqual({ message: { customType: "icm-recall", content: "recalled: prompt fact", display: false } });

		const second = await beforeAgentStart("next prompt");
		expect(second.sections.icm).toBe("# ICM Wake-up\n- wake fact");

		const log = calls();
		expect(log.filter((line) => line.startsWith("hook start"))).toHaveLength(1);
		expect(log.find((line) => line.startsWith("hook start"))).toContain(`"cwd":"${dir}"`);
		const prompts = log.filter((line) => line.startsWith("hook prompt"));
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toContain('"prompt":"what did we decide about MCP?"');
	});

	it("bounds a hung prompt recall and still lets the turn start", async () => {
		process.env.FAKE_ICM_SLOW_PROMPT = "1";
		const { beforeAgentStart } = await setup(true);
		const started = Date.now();
		const { sections, result } = await beforeAgentStart("slow");
		expect(Date.now() - started).toBeLessThan(4000);
		expect(sections.icm).toContain("wake fact");
		expect(result).toBeUndefined();
	}, 10_000);

	it("queues every tenth tool output without blocking and skips noise and icm calls", async () => {
		process.env.FAKE_ICM_SLOW_ENQUEUE = "1";
		const { toolResult } = await setup(true);
		for (let i = 0; i < 20; i++) toolResult("edited file contents here", "edit");
		for (let i = 0; i < 20; i++) toolResult("icm recall output that is long enough", "bash", { command: "icm recall foo" });
		for (let i = 0; i < 9; i++) toolResult(`tool output number ${i} is long enough`);
		const started = Date.now();
		expect(toolResult("tool output number 9 is long enough")).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(100);
		expect(calls().some((line) => line.startsWith("extract"))).toBe(false);

		await vi.waitFor(() => expect(calls().filter((line) => line.startsWith("extract --enqueue"))).toHaveLength(1), { timeout: 5000 });
		const [enqueued] = calls().filter((line) => line.startsWith("extract --enqueue"));
		expect(enqueued).toContain("tool output number 9 is long enough");
		expect(enqueued).not.toContain("number 8");
		expect(calls().some((line) => line.startsWith("extract-pending"))).toBe(false);
	});

	it("queues the assistant transcript before compaction and drains it detached", async () => {
		const { compact } = await setup(true);
		const result = compact([
			{ role: "user", content: [{ type: "text", text: "user words ".repeat(10) }] },
			{ role: "assistant", content: [{ type: "text", text: "We decided to keep the icm extension CLI-only." }, { type: "toolCall", id: "t", name: "bash", arguments: {} }] },
			{ role: "assistant", content: [{ type: "text", text: "Extraction never sends text to an LLM." }] },
		]);
		expect(result).toBeUndefined();

		await vi.waitFor(() => expect(calls().some((line) => line.startsWith("extract-pending --limit 30"))).toBe(true), { timeout: 5000 });
		const [enqueued] = calls().filter((line) => line.startsWith("extract --enqueue"));
		expect(enqueued).toContain("CLI-only.");
		expect(enqueued).toContain("never sends text to an LLM");
		expect(enqueued).not.toContain("user words");
	});
});
