import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let tempHome = "";

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const stub = await import("../../../test/stubs/pi-coding-agent.js");
	return {
		...stub,
		getAgentDir: () => join(tempHome, ".pi", "agent"),
	};
});

// Import AFTER mocks are set up
const { createFlatFallbackCache, createKeyedFallbackCache } = await import("../fallback-cache.js");

beforeAll(async () => {
	tempHome = await mkdtemp(join(tmpdir(), "fallback-cache-test-"));
	mkdirSync(join(tempHome, ".pi", "agent"), { recursive: true });
});

afterAll(async () => {
	if (tempHome) await rm(tempHome, { force: true, recursive: true });
});

beforeEach(() => {
	// Clean slate each test
	const cache = createFlatFallbackCache("flat-test.json");
	cache.clear();
	const keyed = createKeyedFallbackCache("keyed-test.json");
	keyed.clear();
});

describe("createFlatFallbackCache", () => {
	it("returns undefined when cache file is absent", () => {
		const cache = createFlatFallbackCache("flat-test.json");
		expect(cache.read()).toBeUndefined();
	});

	it("writes and reads back an entry", () => {
		const cache = createFlatFallbackCache("flat-test.json");
		cache.write("quota exhausted");

		const entry = cache.read();
		expect(entry?.reason).toBe("quota exhausted");
		expect(entry?.since).toBeTruthy();
		expect(Date.parse(entry!.since)).not.toBeNaN();
	});

	it("persists to file under agent dir with given filename", () => {
		const cache = createFlatFallbackCache("flat-test.json");
		cache.write("test reason");

		const raw = readFileSync(join(tempHome, ".pi", "agent", "flat-test.json"), "utf-8");
		expect(JSON.parse(raw).reason).toBe("test reason");
	});

	it("clear() removes the file", () => {
		const cache = createFlatFallbackCache("flat-test.json");
		cache.write("x");
		expect(cache.read()).toBeDefined();
		cache.clear();
		expect(cache.read()).toBeUndefined();
	});

	it("ignores malformed JSON", () => {
		writeFileSync(join(tempHome, ".pi", "agent", "flat-test.json"), "not json");
		const cache = createFlatFallbackCache("flat-test.json");
		expect(cache.read()).toBeUndefined();
	});

	it("returns undefined for entries older than ttlMs", () => {
		const cache = createFlatFallbackCache("flat-test.json", { ttlMs: 1000 });
		// Manually write an old entry
		writeFileSync(
			join(tempHome, ".pi", "agent", "flat-test.json"),
			JSON.stringify({
				since: new Date(Date.now() - 2000).toISOString(),
				reason: "old",
			}),
		);
		expect(cache.read()).toBeUndefined();
	});

	it("returns entries within ttlMs", () => {
		const cache = createFlatFallbackCache("flat-test.json", { ttlMs: 60000 });
		cache.write("fresh");
		expect(cache.read()?.reason).toBe("fresh");
	});

	it("no TTL means entries never expire", () => {
		const cache = createFlatFallbackCache("flat-test.json"); // no ttlMs
		writeFileSync(
			join(tempHome, ".pi", "agent", "flat-test.json"),
			JSON.stringify({
				since: new Date(0).toISOString(), // year 1970
				reason: "ancient",
			}),
		);
		expect(cache.read()?.reason).toBe("ancient");
	});
});

describe("createKeyedFallbackCache", () => {
	it("returns undefined for missing keys", () => {
		const cache = createKeyedFallbackCache("keyed-test.json");
		expect(cache.read("glm-5.1")).toBeUndefined();
	});

	it("writes and reads one key", () => {
		const cache = createKeyedFallbackCache("keyed-test.json");
		cache.write("glm-5.1", "quota exhausted");
		expect(cache.read("glm-5.1")?.reason).toBe("quota exhausted");
	});

	it("writes multiple keys independently", () => {
		const cache = createKeyedFallbackCache("keyed-test.json");
		cache.write("glm-5.1", "a");
		cache.write("kimi-k2.6", "b");
		expect(cache.read("glm-5.1")?.reason).toBe("a");
		expect(cache.read("kimi-k2.6")?.reason).toBe("b");
	});

	it("readAll returns everything non-expired", () => {
		const cache = createKeyedFallbackCache("keyed-test.json");
		cache.write("a", "r1");
		cache.write("b", "r2");
		const all = cache.readAll();
		expect(Object.keys(all).sort()).toEqual(["a", "b"]);
	});

	it("clearKey removes one entry, leaves others", () => {
		const cache = createKeyedFallbackCache("keyed-test.json");
		cache.write("a", "r1");
		cache.write("b", "r2");
		cache.clearKey("a");
		expect(cache.read("a")).toBeUndefined();
		expect(cache.read("b")?.reason).toBe("r2");
	});

	it("clearKey on last entry removes the file", () => {
		const cache = createKeyedFallbackCache("keyed-test.json");
		cache.write("only", "r1");
		cache.clearKey("only");
		expect(cache.readAll()).toEqual({});
	});

	it("clear() removes the whole file", () => {
		const cache = createKeyedFallbackCache("keyed-test.json");
		cache.write("a", "r1");
		cache.write("b", "r2");
		cache.clear();
		expect(cache.readAll()).toEqual({});
	});

	it("TTL filters expired entries on read", () => {
		const cache = createKeyedFallbackCache("keyed-test.json", { ttlMs: 1000 });
		// Write fresh and old entries directly to bypass since=now
		writeFileSync(
			join(tempHome, ".pi", "agent", "keyed-test.json"),
			JSON.stringify({
				fresh: { since: new Date().toISOString(), reason: "r1" },
				old: { since: new Date(Date.now() - 2000).toISOString(), reason: "r2" },
			}),
		);
		expect(cache.read("fresh")?.reason).toBe("r1");
		expect(cache.read("old")).toBeUndefined();
	});

	it("TTL filters expired in readAll", () => {
		const cache = createKeyedFallbackCache("keyed-test.json", { ttlMs: 1000 });
		writeFileSync(
			join(tempHome, ".pi", "agent", "keyed-test.json"),
			JSON.stringify({
				fresh: { since: new Date().toISOString(), reason: "r1" },
				old: { since: new Date(Date.now() - 2000).toISOString(), reason: "r2" },
			}),
		);
		expect(Object.keys(cache.readAll())).toEqual(["fresh"]);
	});

	it("ignores malformed entries silently", () => {
		writeFileSync(
			join(tempHome, ".pi", "agent", "keyed-test.json"),
			JSON.stringify({
				good: { since: new Date().toISOString(), reason: "ok" },
				bad: "not an object",
				missing: { since: "only since, no reason" },
			}),
		);
		const cache = createKeyedFallbackCache("keyed-test.json");
		expect(cache.read("good")?.reason).toBe("ok");
		expect(cache.read("bad")).toBeUndefined();
		expect(cache.read("missing")).toBeUndefined();
	});
});
