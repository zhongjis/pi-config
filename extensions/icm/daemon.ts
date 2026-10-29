import { readFile, realpath } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

const Descriptor = Type.Object({ url: Type.String(), database: Type.String() }, { additionalProperties: false });
const Importance = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]);
const StoreReply = Type.Object({
	jsonrpc: Type.Literal("2.0"),
	id: Type.Literal(1),
	result: Type.Object({
		content: Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() }), { minItems: 1 }),
		isError: Type.Optional(Type.Boolean()),
	}),
});

export interface DaemonStore {
	readonly url: string;
	readonly importance: "low" | "medium" | "high" | "critical";
}

/** Match only the CLI's resolved store; never reproduce its database selection rules. */
export async function selectDaemon(config: string, cwd: string): Promise<DaemonStore | undefined> {
	const descriptorPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "icm", "daemon.json");
	const descriptor: unknown = JSON.parse(await readFile(descriptorPath, "utf8"));
	if (!Value.Check(Descriptor, descriptor)) return undefined;
	const url = new URL(descriptor.url);
	if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) || url.username || url.password || url.hash) return undefined;
	if (!isAbsolute(descriptor.database)) return undefined;
	const store = /(?:^|\n)\[store\]\s*\n([\s\S]*?)(?=\n\[|$)/.exec(config)?.[1];
	const database = /^\s*resolved\s*=\s*(.+?)\s*$/m.exec(store ?? "")?.[1];
	const memory = /(?:^|\n)\[memory\]\s*\n([\s\S]*?)(?=\n\[|$)/.exec(config)?.[1];
	const importance = /^\s*default_importance\s*=\s*(\S+)\s*$/m.exec(memory ?? "")?.[1];
	if (!database || !Value.Check(Importance, importance)) return undefined;
	const [cliPath, daemonPath] = await Promise.all([realpath(resolve(cwd, database)), realpath(descriptor.database)]);
	return cliPath === daemonPath ? { url: url.href, importance } : undefined;
}

/** Stateless MCP call: a failure may already have committed, so callers must never replay it. */
export function storeDaemon(route: DaemonStore, fact: { readonly topic: string; readonly content: string }, timeout: number): Promise<boolean> {
	return new Promise((resolve) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		const finish = (success: boolean) => { clearTimeout(timer); resolve(success); };
		const req = request(route.url, { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("error", () => finish(false));
			res.on("data", (chunk: string) => {
				body += chunk;
				if (body.length > 1024 * 1024) controller.abort();
			});
			res.on("end", () => {
				try {
					const reply: unknown = JSON.parse(body);
					finish(res.statusCode === 200 && Value.Check(StoreReply, reply) && !("error" in reply) && reply.result.isError !== true);
				} catch (error) {
					if (error instanceof SyntaxError) finish(false);
					else throw error;
				}
			});
		});
		req.on("error", () => finish(false));
		req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "icm_memory_store", arguments: { ...fact, importance: route.importance } } }));
	});
}

/**
 * Native cadence from `icm config`: its `[extraction] extract_every` when extraction is enabled and
 * `[extraction.summarizer] provider = auto`, else undefined (icm's queue extracts).
 * ponytail: line-scans icm's printed config (no TOML dependency installed); replace with a
 * machine-readable icm config query if icm ever exposes one.
 */
export function nativeExtractEvery(config: string): number | undefined {
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
