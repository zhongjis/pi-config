import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { boot, mockRunAgent, plainTheme, required, session } from "./graph-run-registration.fixture.js";
import { gateNode, launch, pendingGate, resolveGate, retrieve } from "./gate-tools.fixture.js";

vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, keyHint: (_key: string, label?: string) => label ?? "" };
});

it("renders canonical calls and graph gates with bounded rows and complete expanded content", async () => {
  const host = boot({ agentGraphEnabled: true });
  await host.lifecycle("session_start");
  const prompt = "批准发布🙂é\n" + "a".repeat(200);
  const id = await launch(host, { nodes: { gate: { ...gateNode, prompt } }, edges: [] });
  const tool = required(host.tools.get("get_agent_result"));
  const call = tool.renderCall({ run_id: id, wait: true }, plainTheme).render(120).join("\n");
  expect(call).toContain("get_agent_result");
  expect(call).toContain(id);
  const result = await retrieve(host, id);
  const before = JSON.stringify(result);
  for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
    const lines = tool.renderResult(result, { expanded: false }, plainTheme, { isError: false }).render(width);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
  const collapsed = tool.renderResult(result, { expanded: false }, plainTheme, { isError: false }).render(120).join("\n");
  expect(collapsed).toContain("Human input required");
  const expanded = tool.renderResult(result, { expanded: true }, plainTheme, { isError: false }).render(240).join("\n");
  expect(expanded).toContain("批准发布");
  expect(expanded.replace(/\n/g, "")).toContain("a".repeat(200));
  expect(expanded).toContain("revision");
  expect(JSON.stringify(result)).toBe(before);
  await resolveGate(host, await pendingGate(host, id));
  const completed = await retrieve(host, id);
  expect(tool.renderResult(completed, { expanded: false }, plainTheme, { isError: false }).render(120).join("\n")).toContain("completed");
  const raw = { content: [{ type: "text", text: "raw failure detail" }] };
  expect(tool.renderResult(raw, { expanded: true }, plainTheme, { isError: true }).render(120).join("\n")).toContain("raw failure detail");
});

it("preserves a graph's declared outcome independently of successful execution", async () => {
  const host = boot({ agentGraphEnabled: true });
  await host.lifecycle("session_start");
  mockRunAgent(async () => ({ responseText: '{"status":"partial","reason":"Missing source"}', session, aborted: false, steered: false }));
  const id = await launch(host, { nodes: { result: { type: "agent", agent: "fixture", prompt: "work", outputSchema: { type: "object" } } }, edges: [], outputs: { $agentGraphOutcome: { node: "result", path: "$" } } });
  const result = await retrieve(host, id);
  expect(result.details).toMatchObject({ status: "completed", outcome: { status: "partial", reason: "Missing source" }, output: {} });
  const tool = required(host.tools.get("get_agent_result"));
  expect(tool.renderResult(result, { expanded: false }, plainTheme, { isError: false }).render(120).join("\n")).toContain("partial");
});
