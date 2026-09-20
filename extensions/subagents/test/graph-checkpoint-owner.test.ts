import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { graphRunsDir, ownGraphRun } from "../src/graph/graph-persist.js";

vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>() }));
let cwd: string | undefined;
afterEach(() => { vi.restoreAllMocks(); if (cwd) fs.rmSync(cwd, { recursive: true, force: true }); });
function fixture() {
  cwd = fs.mkdtempSync(join(tmpdir(), "graph-lock-"));
  const release = ownGraphRun(cwd, "wf_abcdef123456");
  const path = join(graphRunsDir(cwd), "wf_abcdef123456.json.run.lock");
  const metadata: Record<string, unknown> = JSON.parse(fs.readFileSync(path, "utf8"));
  release();
  const dead = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
  expect(dead).toBeGreaterThan(0);
  return { cwd, path, metadata, dead };
}
it("recovers an orphaned recovery guard as well as the dead run owner", () => {
  const { cwd, path, metadata, dead } = fixture();
  fs.writeFileSync(path, JSON.stringify({ ...metadata, pid: dead }));
  fs.writeFileSync(`${path}.recovery`, JSON.stringify({ ...metadata, pid: dead, nonce: randomUUID() }));
  const release = ownGraphRun(cwd, "wf_abcdef123456"); release();
  expect(fs.readdirSync(graphRunsDir(cwd))).toEqual([]);
});
it.skipIf(process.platform !== "linux")("distinguishes a reused PID by process-start identity", () => {
  const { cwd, path, metadata } = fixture();
  expect(metadata.start).toEqual(expect.any(String)); expect(metadata.nonce).toEqual(expect.any(String));
  fs.writeFileSync(path, JSON.stringify({ ...metadata, start: "previous-process-start" }));
  const release = ownGraphRun(cwd, "wf_abcdef123456"); release();
});
it("rechecks ownership under the recovery guard before unlinking", () => {
  const { cwd, path, metadata, dead } = fixture();
  fs.writeFileSync(path, JSON.stringify({ ...metadata, pid: dead }));
  const link = fs.linkSync;
  const replacement = JSON.stringify({ ...metadata, nonce: randomUUID() });
  vi.spyOn(fs, "linkSync").mockImplementation((source, target) => {
    link(source, target);
    if (String(target) === `${path}.recovery`) fs.writeFileSync(path, replacement);
  });
  expect(() => ownGraphRun(cwd, "wf_abcdef123456")).toThrow();
  expect(fs.readFileSync(path, "utf8")).toBe(replacement);
});
