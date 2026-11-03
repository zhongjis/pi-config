import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphRunPaneController, type PaneExec } from "../src/graph/pane/controller.js";
import { readRecord, writeRecord } from "../src/graph/pane/store.js";
const sentinel = "Graph test owner";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "graph-app-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const layout = (terminal = "t-viewer") => JSON.stringify({ spaces: [{ tabs: [{ id: "tab", name: "1", terminals: [{ terminal, pane: "p-viewer" }] }] }] });
function controller(exec: PaneExec) {
  return new GraphRunPaneController({ exec, host: "herdr-app", dir, parentPaneId: "p-parent", cwd: "/work/it's $(literal)", sessionId: "s", viewerPath: "/viewer.mjs", ppid: 42, sentinel });
}
function cli(owner = sentinel) {
  return vi.fn<PaneExec>(async (command, args) => {
    if (command === "herdr-app" && args[0] === "ls") return ok(layout());
    if (args[1] === "pane.split") return ok('{"pane":"p-viewer","terminal":"t-viewer"}');
    if (command === "hc" && args[0] === "get") return ok(JSON.stringify({ address: "t-viewer", state: "live", labels: { "pi.graph-owner": owner } }));
    return ok();
  });
}

describe("herdr-app graph backend", () => {
  it.each([sentinel, "manual owner"])("standalone Node viewer closes only its HC-associated owned pane: %s", async owner => {
    writeRecord(dir, { paneId: "p-viewer", sentinel, closedByUser: false });
    const log = join(dir, "calls.jsonl");
    for (const command of ["herdr-app", "hc", "herdr", "orca"]) {
      writeFileSync(join(dir, command), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(command)},process.argv.slice(2)])+'\\n');\nconsole.log(process.argv[2]==='ls' ? ${JSON.stringify(layout())} : ${JSON.stringify(JSON.stringify({ address: "t-viewer", state: "live", labels: { "pi.graph-owner": owner } }))});\n`, { mode: 0o700 });
    }
    // CLI fixtures share an isolated module scope and never reach the user's CLIs.
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    const viewer = fileURLToPath(new URL("../src/graph/pane/viewer.mjs", import.meta.url));
    const child = spawn(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(viewer)}); process.stdout.write('READY');`, "--", "viewer", "--dir", dir, "--host", "herdr-app"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HC_TERMINAL_ID: "t-viewer", HERDR_ENV: "1", HERDR_PANE_ID: "stale-native", ORCA_TERMINAL_HANDLE: "stale-orca" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.includes("READY")) child.kill("SIGINT"); });
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    expect(code).toBe(0);
    const calls: unknown[] = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls).toContainEqual(["hc", ["get", "t-viewer", "--json"]]);
    expect(calls.filter(call => Array.isArray(call) && Array.isArray(call[1]) && call[1].includes("pane.close"))).toEqual(owner === sentinel ? [["herdr-app", ["do", "pane.close", "--pane", "p-viewer"]]] : []);
    expect(readRecord(dir)?.closedByUser).toBe(true);
  });
  it("creates an argv-launched viewer, restores parent focus and records labelled ownership", async () => {
    const exec = cli();
    await controller(exec).ensurePane(false);
    const args = exec.mock.calls[0]?.[1] ?? [];
    expect(args.slice(0, 6)).toEqual(["do", "pane.split", "--pane", "p-parent", "--direction", "right"]);
    expect(JSON.parse(args[7] ?? "[]")).toEqual(["sh", "-c", 'cd -- "$1" && shift && exec "$@"', "pi-pane", "/work/it's $(literal)", "node", "/viewer.mjs", "--dir", dir, "--ppid", "42", "--host", "herdr-app"]);
    expect(exec.mock.calls.slice(1).map(call => [call[0], call[1]])).toEqual([
      ["herdr-app", ["do", "pane.focus", "--pane", "p-parent"]],
      ["hc", ["label", "t-viewer", `pi.graph-owner=${sentinel}`, "--json"]],
    ]);
    expect(readRecord(dir)).toEqual({ paneId: "p-viewer", sentinel, closedByUser: false });
  });
  it("adopts only a live pane with the sentinel on its associated terminal", async () => {
    writeRecord(dir, { paneId: "p-viewer", sentinel, closedByUser: false });
    const exec = cli();
    await controller(exec).ensurePane(false);
    expect(exec.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ["herdr-app", ["ls"]], ["hc", ["get", "t-viewer", "--json"]],
    ]);
  });
  it("closes only a verified associated pane", async () => {
    writeRecord(dir, { paneId: "p-viewer", sentinel, closedByUser: false });
    const exec = cli();
    await controller(exec).closeOwned();
    expect(exec).toHaveBeenLastCalledWith("herdr-app", ["do", "pane.close", "--pane", "p-viewer"], expect.any(Object));
    expect(readRecord(dir)).toBeUndefined();
  });
  it.each(["repurposed", "malformed", "mismatched terminal"])("preserves %s panes on dispose", async kind => {
    writeRecord(dir, { paneId: "p-viewer", sentinel, closedByUser: false });
    const exec = cli("manual");
    if (kind === "malformed") exec.mockResolvedValue(ok("{}"));
    if (kind === "mismatched terminal") exec.mockImplementation(async () => ok(layout("t-replacement")));
    await controller(exec).closeOwned();
    expect(exec.mock.calls.some(call => call[1].includes("pane.close"))).toBe(false);
  });
  it("remembers a user close without reopening", async () => {
    writeRecord(dir, { paneId: "p-viewer", sentinel, closedByUser: false });
    const exec = cli();
    const pane = controller(exec);
    await pane.closeForUser();
    exec.mockClear();
    await pane.reconcile();
    await pane.ensurePane(false);
    expect(exec).not.toHaveBeenCalled();
    expect(readRecord(dir)?.closedByUser).toBe(true);
  });
  it.each(["label failure", "malformed split", "timeout"])("suppresses automatic respawn after %s", async kind => {
    const exec = cli();
    if (kind === "label failure") exec.mockImplementation(async (cmd, args) => cmd === "hc" ? { code: 1, stdout: "", stderr: "failed" } : args[1] === "pane.split" ? ok('{"pane":"p-viewer","terminal":"t-viewer"}') : ok());
    if (kind === "malformed split") exec.mockResolvedValue(ok("{}"));
    if (kind === "timeout") exec.mockResolvedValue({ code: 1, stdout: "", stderr: "timeout", killed: true });
    const pane = controller(exec);
    await pane.ensurePane(false);
    exec.mockClear();
    await pane.ensurePane(false);
    expect(exec).not.toHaveBeenCalled();
    expect(readRecord(dir)?.closedByUser).toBe(true);
  });
});
