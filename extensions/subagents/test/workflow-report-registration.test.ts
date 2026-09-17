// biome-ignore assist/source/organizeImports: the fixture's vi.mock must be imported before ../src modules so the mock applies
import { boot, dir, plainTheme, required, session } from "./workflow-registration.fixture.js";
import { runAgent } from "../src/agent-runner.js";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";

function workflowMessageRenderer(host: ReturnType<typeof boot>) {
  return required(host.api.registerMessageRenderer.mock.calls.find(([name]) => name === "subagent-notification"))[1];
}

it("presents structured results and every configured child identity through registered renderers", async () => {
  for (const name of ["wenchang", "chengfeng", "taishang"]) {
    writeFileSync(join(dir, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ndescription: fixture\n---\nTask`);
  }
  const host = boot({ workflowsEnabled: true });
  const script = `export const meta={name:'graph-engineering-research',description:'fixture'};
    phase('Research');
    await parallel([
      () => agent('one',{label:'eigent',agentType:'wenchang'}),
      () => agent('two',{label:'primary-sources',agentType:'wenchang'}),
      () => agent('three',{label:'our-runtime',agentType:'chengfeng'})
    ]);
    phase('Review');
    await agent('four',{label:'architecture-review',agentType:'taishang'});
    return {research:'research answer',review:'review answer'};`;
  const result = await host.execute({ script });
  const message = await host.notification(required(result.details?.taskId));
  const tool = required(host.tools.get("SubagentWorkflow"));
  const before = JSON.stringify({ result, message });
  const compact = tool.renderResult(result, { expanded: false }, plainTheme, { isError: false }).render(120).join("\n");
  expect(compact).toContain("Outcome not declared · structured result");
  expect(compact).toContain("4 agents completed · fields: research, review");
  expect(compact).not.toMatch(/Completed · \{(?:\n|$)/);
  const report = tool.renderResult(result, { expanded: true }, plainTheme, { isError: false }).render(120).join("\n");
  for (const marker of ["eigent", "primary-sources", "our-runtime", "architecture-review", "wenchang", "chengfeng", "taishang"]) expect(report).toContain(marker);
  expect(report.indexOf("research answer")).toBeLessThan(report.indexOf("Agents"));
  expect(report.indexOf("Agents")).toBeLessThan(report.indexOf("Retained details"));
  const renderMessage = workflowMessageRenderer(host);
  const notification = renderMessage(message, { expanded: false }, plainTheme).render(120);
  expect(notification).toHaveLength(3);
  expect(notification.join("\n")).toContain("Workflow outcome not declared · graph-engineering-research");
  expect(notification.join("\n")).toContain("returned research, review");
  expect(notification.join("\n")).not.toMatch(/\d[\d,.]* (tokens|tools)|duration/i);
  await host.lifecycle("session_shutdown");
  const restored: unknown = JSON.parse(JSON.stringify(message));
  expect(renderMessage(restored, { expanded: true }, plainTheme).render(120).join("\n")).toContain("architecture-review");
  expect(JSON.stringify({ result, message })).toBe(before);
  expect(host.api.sendMessage).toHaveBeenCalledTimes(1);
  expect(host.api.sendMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
});

it("shows the first active label and type plus concurrent count without stale terminal activity", async () => {
  const host = boot({ workflowsEnabled: true });
  const releases: (() => void)[] = [];
  vi.mocked(runAgent).mockImplementation(async () => {
    await new Promise<void>(resolve => releases.push(resolve));
    return { responseText: "done", session, aborted: false, steered: false };
  });
  const result = await host.execute({ script: `export const meta={name:'concurrent',description:'fixture'};
    await parallel(['first','second','third'].map(label => () => agent(label,{label,agentType:'fixture'}))); return {};` });
  const tool = required(host.tools.get("SubagentWorkflow"));
  try {
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    const rows = tool.renderResult(result, { expanded: false }, plainTheme, { isError: false }).render(120);
    expect(rows.join("\n")).toContain("Running · 3 active");
    expect(rows.join("\n")).toContain("first · fixture · +2 active tasks");
  } finally {
    for (const release of releases) release();
  }
  await host.notification(required(result.details?.taskId));
  expect(tool.renderResult(result, { expanded: false }, plainTheme, { isError: false }).render(120).join("\n")).not.toContain("active tasks");
});

it.each([600, 5100])("retains the complete %i-character notification answer after serialization", async length => {
  const host = boot({ workflowsEnabled: true });
  const full = "preview\n" + "x".repeat(length) + "\nnotification-tail";
  const result = await host.execute({ script: "export const meta={name:'retained',description:'fixture'};return " + JSON.stringify(full) });
  const message = await host.notification(required(result.details?.taskId));
  const before = JSON.stringify(message);
  const renderMessage = workflowMessageRenderer(host);
  const restored: unknown = JSON.parse(before);
  const expanded = renderMessage(restored, { expanded: true }, plainTheme).render(80).join("\n");
  expect(expanded).toContain("notification-tail");
  if (length > 4000) {
    expect(message.content).toContain(`<result>${full.slice(0, 4000)}\n...(truncated)</result>`);
    expect(message.content).not.toContain("notification-tail");
    const path = message.content.match(/Full workflow result: (.+)/)?.[1];
    assert.ok(path);
    expect(expanded.replace(/\n/g, "")).toContain(path);
  } else {
    expect(message.content).toContain(`<result>${full}</result>`);
    expect(expanded).not.toContain("Full result");
  }
  expect(JSON.stringify(message)).toBe(before);
  expect(host.api.sendMessage).toHaveBeenCalledTimes(1);
});

it("includes artifact failure diagnostics and the retained answer in expanded notifications", async () => {
  const host = boot({ workflowsEnabled: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const full = "x".repeat(5100) + "\nartifact-failure-tail";
  const result = await host.execute({ script: "export const meta={name:'artifact',description:'fixture'};return " + JSON.stringify(full) });
  const id = required(result.details?.taskId);
  const scriptPath = required(result.content[0]?.text?.match(/Script: (.+)/)?.[1]);
  mkdirSync(join(dirname(scriptPath), `${id}.workflow-result.txt`));
  const message = await host.notification(id);
  const report = workflowMessageRenderer(host)(message, { expanded: true }, plainTheme).render(120).join("\n");
  expect(report).toContain("artifact-failure-tail");
  expect(report).toContain("Full workflow result could not be saved");
  expect(report).not.toContain("Full result\n");
  expect(message.content).toContain("Warning: Full workflow result could not be saved");
});

it("keeps missing-live-state and execution-error fallbacks compact while retaining raw content", async () => {
  const host = boot({ workflowsEnabled: true });
  const tool = required(host.tools.get("SubagentWorkflow"));
  const raw = "raw-start\n" + "界".repeat(200) + "\nraw-tail";
  const result = { content: [{ type: "text" as const, text: raw }], details: { taskId: "wf_absent" } };
  const before = JSON.stringify(result);
  for (const isError of [false, true]) {
    const compact = tool.renderResult(result, { expanded: false }, plainTheme, { isError }).render(40);
    expect(compact.length).toBeLessThanOrEqual(3);
    expect(compact.join("\n")).toContain(isError ? "Failed" : "Live workflow state unavailable");
    const expanded = tool.renderResult(result, { expanded: true }, plainTheme, { isError }).render(40).join("\n");
    expect(expanded).toContain("raw-tail");
  }
  expect(JSON.stringify(result)).toBe(before);
});

it("falls back to original message content for malformed workflow snapshots", async () => {
  const host = boot({ workflowsEnabled: true });
  const result = await host.execute({ script: "export const meta={name:'raw',description:'fixture'}; return 1;" });
  const message = await host.notification(required(result.details?.taskId));
  const malformed = { ...message, content: "original-raw\noriginal-tail", details: { ...message.details, workflow: { status: "completed", progress: [null] } } };
  const renderer = workflowMessageRenderer(host);
  expect(renderer(malformed, { expanded: true }, plainTheme).render(80).join("\n")).toBe(malformed.content);
  expect(renderer(malformed, { expanded: false }, plainTheme).render(20).length).toBeLessThanOrEqual(3);
});

it.each(["fail", "partial", "succeed"])("renders explicit %s separately from execution after reload", async method => {
  const host = boot({ workflowsEnabled: true });
  const result = await host.execute({ script: `export const meta={name:'outcome',description:'fixture'};
    await agent('evidence', {agentType:'fixture'});
    return outcome.${method}(${method === "succeed" ? "" : "'verification failed', "}{ retained: 'payload-tail' });` });
  const message = await host.notification(required(result.details?.taskId));
  const restored = JSON.parse(JSON.stringify(message));
  const renderer = workflowMessageRenderer(host);
  const status = method === "fail" ? "failed" : method === "succeed" ? "succeeded" : "partial";
  for (const expanded of [false, true]) {
    const report = renderer(restored, { expanded }, plainTheme).render(120).join("\n");
    expect(report).toContain(`outcome ${status}`);
    expect(report).toContain("Execution: completed");
    expect(report).toContain("1 agent completed");
    if (expanded) expect(report).toContain("payload-tail");
  }
  expect(message.content).toContain(`Outcome ${status}`);
  expect(host.api.sendMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
});
