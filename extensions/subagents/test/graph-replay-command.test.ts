import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { encodeCwd } from "../src/output-file.js";
import { artifactDirs, boot, dir, required } from "./graph-run-registration.fixture.js";

const graph = {
  name: "demo",
  nodes: { a: { type: "agent", agent: "fixture", prompt: "do a" }, b: { type: "agent", agent: "fixture", prompt: "do b" } },
  edges: [{ from: "a", to: "b" }],
  outputs: { r: { node: "b", path: "$" } },
};
type Host = ReturnType<typeof boot>;
async function replay(host: Host, args: string): Promise<[string, string]> {
  host.ui.notify.mockClear();
  await required(host.commands.get("agent-graph-replay")).handler(args, host.ctx as ExtensionContext);
  expect(host.ui.notify).toHaveBeenCalledTimes(1);
  return host.ui.notify.mock.calls[0] as [string, string];
}

describe("/agent-graph-replay", () => {
  it("registers the replay command", () => {
    expect(boot().commands.has("agent-graph-replay")).toBe(true);
  });

  it("rejects bad arguments, traversal run IDs, missing traces, and invalid graphs without throwing", async () => {
    const host = boot();
    await host.lifecycle("session_start");
    expect(await replay(host, "")).toEqual([expect.stringContaining("Usage: /agent-graph-replay <runId> <graph>"), "error"]);
    expect(await replay(host, "../agr_abc123 demo")).toEqual([expect.stringContaining("Invalid graph run ID"), "error"]);
    expect(await replay(host, "agr_abc123 demo")).toEqual([expect.stringContaining("No graph trace for agr_abc123 in this session"), "error"]);
  });

  it("replays a recorded run against a saved candidate and a graph file path", async () => {
    artifactDirs.add(join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encodeCwd(dir)));
    const host = boot();
    await host.lifecycle("session_start");
    const result = await required(host.tools.get("agent_graph")).execute("call", { graph, input: {} }, undefined, undefined, host.ctx);
    const runId = required(result.details?.taskId);
    await host.notification(runId);

    mkdirSync(join(dir, ".pi", "agent-graphs"), { recursive: true });
    writeFileSync(join(dir, ".pi", "agent-graphs", "same.graph.json"), JSON.stringify(graph));
    const [same, sameLevel] = await replay(host, `${runId} same`);
    expect(sameLevel).toBe("info");
    expect(same).toContain(`Replay ${runId} against same`);
    expect(same).toContain("Self-consistency: ok");
    expect(same).toContain("No differences.");

    const candidate = { ...graph, edges: [{ from: "a", to: "b", when: { eq: [{ node: "a", path: "$.missing" }, true] } }] };
    writeFileSync(join(dir, "candidate.graph.json"), JSON.stringify(candidate));
    const [diff] = await replay(host, `${runId} ./candidate.graph.json`);
    expect(diff).toContain("b  completed → skipped");
    expect(diff).toContain("a→b  active → inactive");
    expect(diff.split("\n").every(line => line.length <= 100)).toBe(true);

    writeFileSync(join(dir, "broken.graph.json"), JSON.stringify({ nodes: {}, edges: [] }));
    expect(await replay(host, `${runId} ./broken.graph.json`)).toEqual([expect.stringContaining("Invalid agent graph"), "error"]);
  });
});
