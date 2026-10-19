import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCache, isTerminalState, RENDER_VERSION } from "../cache.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ghfs-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("cache key", () => {
  it("includes the render version in every key", () => {
    const parts = { host: "github.com", account: "u" };
    const key = createCache({ agentDir: dir }).key(parts);
    expect(key).toBe(createHash("sha256").update(JSON.stringify({ v: RENDER_VERSION, parts })).digest("hex").slice(0, 32));
    expect(key).not.toBe(createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32));
  });
  it("is stable and distinguishes account identity", () => {
    const cache = createCache({ agentDir: dir });
    const base = { host: "github.com", repo: "o/r", kind: "single", number: 1 };
    expect(cache.key({ ...base, account: "a" })).toBe(cache.key({ ...base, account: "a" }));
    expect(cache.key({ ...base, account: "a" })).not.toBe(cache.key({ ...base, account: "b" }));
  });
});

describe("get/put freshness", () => {
  it("misses on empty, hits after put", async () => {
    const cache = createCache({ agentDir: dir });
    const key = cache.key({ x: 1 });
    expect(await cache.get(key, { refresh: false })).toBeNull();
    const path = await cache.put(key, "# hi", { terminal: false });
    expect(await cache.get(key, { refresh: false })).toBe(path);
  });

  it("refresh=1 forces a miss even when fresh", async () => {
    const cache = createCache({ agentDir: dir });
    const key = cache.key({ x: 2 });
    await cache.put(key, "body", { terminal: false });
    expect(await cache.get(key, { refresh: true })).toBeNull();
  });

  it("expires non-terminal entries past the soft TTL", async () => {
    let clock = 1_000_000;
    const cache = createCache({ agentDir: dir, now: () => clock });
    const key = cache.key({ x: 3 });
    await cache.put(key, "body", { terminal: false });
    clock += 4 * 60 * 1000; // within soft TTL
    expect(await cache.get(key, { refresh: false })).not.toBeNull();
    clock += 2 * 60 * 1000; // now past 5 min
    expect(await cache.get(key, { refresh: false })).toBeNull();
  });

  it("serves terminal entries regardless of age", async () => {
    let clock = 1_000_000;
    const cache = createCache({ agentDir: dir, now: () => clock });
    const key = cache.key({ x: 4 });
    await cache.put(key, "merged pr", { terminal: true });
    clock += 30 * 24 * 60 * 60 * 1000; // 30 days later
    expect(await cache.get(key, { refresh: false })).not.toBeNull();
  });
});

describe("file permissions", () => {
  it("writes content 0600 in a 0700 dir", async () => {
    const cache = createCache({ agentDir: dir });
    const key = cache.key({ x: 5 });
    const path = await cache.put(key, "secretless body", { terminal: false });
    const fileMode = (await stat(path)).mode & 0o777;
    const dirMode = (await stat(join(dir, "github-fs-cache"))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });
});

describe("isTerminalState", () => {
  it("treats only MERGED as terminal", () => {
    expect(isTerminalState("MERGED")).toBe(true);
    expect(isTerminalState("closed")).toBe(false);
    expect(isTerminalState("OPEN")).toBe(false);
    expect(isTerminalState(undefined)).toBe(false);
  });
});

describe("content extension", () => {
  it("materializes a content file with the given extension", async () => {
    const cache = createCache({ agentDir: dir });
    const key = cache.key({ x: "ext" });
    const path = await cache.put(key, "const x = 1;", { terminal: false, ext: ".ts" });
    expect(path.endsWith(".ts")).toBe(true);
    expect(await cache.get(key, { refresh: false })).toBe(path);
  });

  it("defaults to .md when no ext is given", async () => {
    const cache = createCache({ agentDir: dir });
    const key = cache.key({ x: "default-ext" });
    const path = await cache.put(key, "# md", { terminal: false });
    expect(path.endsWith(".md")).toBe(true);
  });

  it("does not clobber a .json content file with its metadata sidecar", async () => {
    const cache = createCache({ agentDir: dir });
    const key = cache.key({ x: "json-collision" });
    const body = '{"name":"pkg","version":"1.0.0"}';
    const path = await cache.put(key, body, { terminal: false, ext: ".json" });
    expect(await cache.get(key, { refresh: false })).toBe(path);
    expect(await readFile(path, "utf8")).toBe(body);
  });
});
