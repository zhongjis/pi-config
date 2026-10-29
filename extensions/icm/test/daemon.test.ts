import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { selectDaemon, storeDaemon } from "../daemon.js";
import icmExtension from "../index.js";

let dir: string;
let url: string;
let database: string;
let server: Server;
let requests: unknown[];
let answer: (res: import("node:http").ServerResponse) => void;
const success = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "stored" }], resultType: "complete" } };
const config = () => `[store]\n  resolved = memories.db\n[memory]\n  default_importance = high\n[extraction]\n  enabled = true\n  extract_every = 1\n[extraction.summarizer]\n  provider = auto\n`;
const descriptor = (value: unknown) => writeFileSync(join(dir, "icm", "daemon.json"), JSON.stringify(value));
const stores = () => existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").split("\n").filter((line) => line.startsWith("store ")) : [];

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "icm-daemon-"));
	database = join(dir, "memories.db");
	writeFileSync(database, "");
	mkdirSync(join(dir, "icm"));
	vi.stubEnv("XDG_CONFIG_HOME", dir);
	requests = [];
	answer = (res) => res.end(JSON.stringify(success));
	server = createServer((req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (part: string) => { body += part; });
		req.on("end", () => {
			requests.push({ method: req.method, path: req.url, body: JSON.parse(body) });
			answer(res);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing test server address");
	url = `http://127.0.0.1:${address.port}/mcp`;
	descriptor({ url, database });
});

afterEach(async () => {
	server.closeAllConnections();
	if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

async function capture() {
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(dir, "config"), config());
	writeFileSync(join(bin, "icm"), `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' "$*" >> '${dir}/calls'\n[ "$1" != config ] || cat '${dir}/config'\n`, { mode: 0o755 });
	vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
	// Avoid testing project discovery through unrelated host git configuration.
	execFileSync("git", ["init", "-q", dir]);
	execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://example.invalid/test-project.git"]);
	const mock = createMockPi();
	icmExtension(mock.pi as never);
	const ctx = { ...createMockContext(), cwd: dir, modelRegistry: {
		...createMockContext().modelRegistry,
		hasConfiguredAuth: () => true,
		complete: vi.fn(async () => ({ stopReason: "stop", content: [{ type: "text", text: "- Private first fact.\n- Private second fact." }] })),
	} };
	const handler = (name: string) => {
		const registered = mock.lifecycleHandlers.get(name)?.[0];
		if (!registered) throw new Error(`missing test handler: ${name}`);
		return registered;
	};
	await handler("session_start")({ type: "session_start" }, ctx);
	await handler("before_agent_start")({ messageType: "user", prompt: "", systemPromptOptions: { sections: {} } }, ctx);
	handler("tool_result")({ toolName: "read", input: {}, content: [{ type: "text", text: "A tool output with enough durable details." }] }, ctx);
}

describe("native daemon routing", () => {
	it("canonicalizes both paths and preserves configured importance", async () => {
		const alias = join(dir, "alias.db");
		symlinkSync(database, alias);
		descriptor({ url, database: alias });
		expect(await selectDaemon(config(), dir)).toStrictEqual({ url, importance: "high" });
	});

	it.each([
		{ url: "https://127.0.0.1/mcp" }, { url: "http://example.com/mcp" },
		{ url: "http://127.0.0.1@evil.example/mcp" }, { database: "relative.db" },
		{ database: "/missing/memories.db" }, { extra: true },
	])("declines invalid descriptor %j before HTTP", async (change) => {
		descriptor({ url, database, ...change });
		await expect(selectDaemon(config(), dir).catch(() => undefined)).resolves.toBeUndefined();
		expect(requests).toHaveLength(0);
	});

	it.each(["missing", "mismatch", "malformed", "unresolved"])("uses CLI before HTTP for %s config", async (mode) => {
		if (mode === "missing") rmSync(join(dir, "icm", "daemon.json"));
		if (mode === "malformed") writeFileSync(join(dir, "icm", "daemon.json"), "{");
		if (mode === "unresolved") rmSync(database);
		if (mode === "mismatch") {
			const other = join(dir, "other.db");
			writeFileSync(other, "");
			descriptor({ url, database: other });
		}
		await capture();
		await vi.waitFor(() => expect(stores()).toHaveLength(2));
		expect(requests).toHaveLength(0);
	});

	it("stores native facts sequentially through exact stateless MCP calls", async () => {
		await capture();
		await vi.waitFor(() => expect(requests).toHaveLength(2));
		expect(requests).toStrictEqual(["Private first fact.", "Private second fact."].map((content) => ({
			method: "POST", path: "/mcp", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
				name: "icm_memory_store", arguments: { topic: "context-test-project", content, importance: "high" },
			} },
		})));
		expect(stores()).toHaveLength(0);
	});

	it.each(["RPC error", "connection refused"])("continues after %s without CLI replay or leaking facts", async (failure) => {
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
		vi.stubEnv("PANDA_DEBUG", "icm");
		if (failure === "connection refused") await new Promise<void>((resolve) => server.close(() => resolve()));
		else answer = (res) => res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "Private first fact." } }));
		await capture();
		await vi.waitFor(() => expect(debug).toHaveBeenCalledTimes(2));
		expect(requests).toHaveLength(failure === "connection refused" ? 0 : 2);
		expect(stores()).toHaveLength(0);
		expect(JSON.stringify(debug.mock.calls)).not.toContain("Private");
		debug.mockRestore();
	});
});

describe("daemon store response boundary", () => {
	it.each([
		[200, "not JSON"], [503, JSON.stringify(success)], [200, "{}"],
		[200, JSON.stringify({ ...success, id: 2 })],
		[200, JSON.stringify({ ...success, error: { message: "secret" } })],
		[200, JSON.stringify({ ...success, result: { ...success.result, isError: true } })],
		[200, JSON.stringify({ ...success, result: { content: [] } })],
		[200, JSON.stringify({ ...success, result: { content: [{ type: "text" }] } })],
		[200, JSON.stringify({ ...success, result: { content: [{ type: "image", text: "bad" }] } })],
		[200, JSON.stringify({ ...success, result: { content: [{ type: "text", text: 42 }] } })],
		[200, JSON.stringify({ ...success, result: { content: "bad" } })],
	])("rejects status/envelope %s %s", async (status, body) => {
		answer = (res) => { res.statusCode = status; res.end(body); };
		await expect(storeDaemon({ url, importance: "medium" }, { topic: "test", content: "secret" }, 1000)).resolves.toBe(false);
	});

	it("aborts a stalled response at the deadline", async () => {
		const closed = new Promise<void>((resolve) => { answer = (res) => { res.on("close", resolve); res.write("{"); }; });
		await expect(storeDaemon({ url, importance: "medium" }, { topic: "test", content: "secret" }, 25)).resolves.toBe(false);
		await closed;
	});
});
