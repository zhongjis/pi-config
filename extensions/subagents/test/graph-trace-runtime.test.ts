import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { graphRuntimeLogPath, graphTracePath } from "../src/graph/trace.js";
import { encodeCwd } from "../src/output-file.js";
import { artifactDirs, boot, dir, required, settingsUI } from "./graph-run-registration.fixture.js";

const graph = {
  name: "demo",
  nodes: { a: { type: "agent", agent: "fixture", prompt: "do a" }, b: { type: "agent", agent: "fixture", prompt: "do b" } },
  edges: [{ from: "a", to: "b" }],
  outputs: { r: { node: "b", path: "$" } },
};
const track = () => artifactDirs.add(join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encodeCwd(dir)));

describe("agent_graph trace artifact", () => {
  it("writes a settled trace for every run in the exact-session artifact area", async () => {
    track();
    const host = boot();
    await host.lifecycle("session_start");
    const result = await required(host.tools.get("agent_graph")).execute("call", { graph, input: { task: "t" } }, undefined, undefined, host.ctx);
    const runId = required(result.details?.taskId);
    await host.notification(runId);
    const path = graphTracePath(dir, "parent", runId);
    const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(rows[0]).toMatchObject({ type: "header", runId, input: { task: "t" }, graph });
    expect(rows.filter(row => row.type === "node" && row.status === "completed").map(row => row.nodeId)).toEqual(["a", "b"]);
    expect(rows.at(-1)).toMatchObject({ type: "end", status: "completed" });
    expect(readFileSync(join(dir, ".pi", "subagents.json"), "utf8")).not.toContain(runId);
  });

  it("keeps runs unaffected by trace I/O failure and warns once per session", async () => {
    track();
    const blocked = dirname(graphTracePath(dir, "parent", "agr_000000"));
    mkdirSync(dirname(blocked), { recursive: true });
    writeFileSync(blocked, "");
    const host = boot();
    await host.lifecycle("session_start");
    const tool = required(host.tools.get("agent_graph"));
    for (let i = 0; i < 2; i++) {
      const result = await tool.execute("call", { graph, input: {} }, undefined, undefined, host.ctx);
      const message = await host.notification(required(result.details?.taskId));
      expect(message.content).toContain("Execution: completed");
    }
    expect(host.ui.notify.mock.calls.filter(([text]) => text === "Graph trace is unavailable; execution is unaffected.")).toHaveLength(1);
    expect(existsSync(blocked)).toBe(true);
  });
});

describe("graph runtime trace setting", () => {
  const run = async (host: ReturnType<typeof boot>) => {
    const result = await required(host.tools.get("agent_graph")).execute("call", { graph, input: {} }, undefined, undefined, host.ctx);
    const runId = required(result.details?.taskId);
    await host.notification(runId);
    return runId;
  };

  it("writes no runtime log by default and starts logging after a live settings toggle", async () => {
    track();
    const host = boot();
    await host.lifecycle("session_start");
    const off = await run(host);
    expect(existsSync(graphTracePath(dir, "parent", off))).toBe(true);
    expect(existsSync(graphRuntimeLogPath(dir, "parent", off))).toBe(false);

    host.ui.select.mockResolvedValueOnce("Settings");
    host.ui.custom.mockImplementationOnce(async (factory: (...args: unknown[]) => unknown) => { factory(undefined, undefined, undefined, () => {}); return undefined; });
    await required(host.commands.get("agents")).handler("", host.ctx);
    required(settingsUI.change)("graphRuntimeTrace", "on");
    expect(host.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Graph runtime trace enabled for new graph runs"), "info");
    expect(JSON.parse(readFileSync(join(dir, ".pi", "subagents.json"), "utf8"))).toMatchObject({ graphRuntimeTrace: true });

    const on = await run(host);
    const lines = readFileSync(graphRuntimeLogPath(dir, "parent", on), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(new Set(lines.map(line => line.type))).toEqual(new Set(["@xstate.event", "@xstate.microstep"]));
    expect(lines.some(line => "context" in line)).toBe(false);
  });

  it("keeps runs unaffected by runtime log I/O failure and warns once per session", async () => {
    track();
    const blocked = dirname(graphRuntimeLogPath(dir, "parent", "agr_000000"));
    mkdirSync(dirname(blocked), { recursive: true });
    writeFileSync(blocked, "");
    const host = boot({ graphRuntimeTrace: true });
    await host.lifecycle("session_start");
    for (let i = 0; i < 2; i++) await run(host);
    expect(host.ui.notify.mock.calls.filter(([text]) => text === "Graph runtime trace is unavailable; execution is unaffected.")).toHaveLength(1);
  });
});
