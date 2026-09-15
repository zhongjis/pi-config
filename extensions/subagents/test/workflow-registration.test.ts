import { artifactDirs, boot, dir, originalCwd, plainTheme, required, session, settingsUI, source } from "./workflow-registration.fixture.js";
import { runAgent } from "../src/agent-runner.js";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { AgentManager } from "../src/agent-manager.js";
import { WORKFLOW_ENTRY_TYPE, WORKFLOW_FILE_FLAG } from "../src/index.js";
import { loadSettings } from "../src/settings.js";
import { decideWorkflowCollision } from "../src/workflow/collisions.js";
import * as workflowHost from "../src/workflow/host.js";
import * as workflowTask from "../src/workflow/task.js";
import * as outputFile from "../src/output-file.js";
import { validateScript } from "../src/workflow/runtime.js";
import { listSavedWorkflows, resolveWorkflowScript } from "../src/workflow/saved.js";

it("registers no workflow tool by default; the flag is read only at startup", async () => {
  const host = boot();
  expect(host.tools.has("SubagentWorkflow")).toBe(false);
  expect(await host.discover()).toEqual([]);
  expect(host.api.getFlag).not.toHaveBeenCalled();
  expect(host.api.registerFlag).toHaveBeenCalledWith(WORKFLOW_FILE_FLAG, expect.objectContaining({ type: "string" }));
  host.setFlag("missing.js");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await host.lifecycle("session_start");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("workflows are off"));
  expect(runAgent).not.toHaveBeenCalled();
});

it.each([false, "true", 1, null])("keeps workflows disabled for non-opt-in settings %s", (workflowsEnabled) => {
  const host = boot({ workflowsEnabled });
  expect(host.tools.has("SubagentWorkflow")).toBe(false);
  expect(loadSettings(dir).workflowsEnabled).toBe(workflowsEnabled === false ? false : undefined);
});

it("persists the Settings toggle but registers its schema only on the next activation", async () => {
  const host = boot();
  host.ui.select.mockResolvedValueOnce("Settings").mockResolvedValueOnce(undefined);
  host.ui.custom.mockImplementation(async (factory) => {
    factory({}, {}, {}, () => {});
    required(settingsUI.change)("workflowsEnabled", "on");
    return undefined;
  });
  await required(host.commands.get("agents")).handler("", host.ctx);
  expect(loadSettings(dir).workflowsEnabled).toBe(true);
  expect(host.tools.has("SubagentWorkflow")).toBe(false);
  await host.lifecycle("session_shutdown");
  const reloaded = boot({ ...loadSettings(dir) });
  expect(reloaded.tools.get("SubagentWorkflow")?.parameters.properties).toHaveProperty("resumeFromRunId");
});

it("discovers the bundled authoring skill only when workflows are enabled", async () => {
  const host = boot({ workflowsEnabled: true });
  const resources = await host.discover();
  expect(resources).toEqual([{ skillPaths: [expect.any(String)] }]);
  const resource = required(resources[0]);
  assert.ok(resource !== null && typeof resource === "object" && "skillPaths" in resource);
  assert.ok(Array.isArray(resource.skillPaths));
  const path: unknown = resource.skillPaths[0];
  assert.ok(typeof path === "string");
  expect(path).toBe(join(originalCwd, "extensions/subagents/skills/subagent-workflows/SKILL.md"));
  const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));
  expect(frontmatter.name).toBe("subagent-workflows");
  expect(frontmatter.description).toEqual(expect.any(String));
  const examples = [...body.matchAll(/^```js\n([\s\S]*?)^```/gm)].map(match => match[1]);
  expect(examples.length).toBeGreaterThanOrEqual(2);
  expect(examples.length).toBeLessThanOrEqual(3);
  const names = examples.map(script => validateScript(script).meta.name);
  expect(new Set(names).size).toBe(examples.length);
  const tool = required(host.tools.get("SubagentWorkflow"));
  expect(tool.description.length).toBeLessThan(1000);
  expect(tool.description).toContain(path);
});

it("runs owned children, emits one owner notification, and drains native usage once on a final workflow result", async () => {
  const host = boot({ workflowsEnabled: true, reportUsage: true });
  const result = await host.execute({ script: source, args: { prompt: "original\nexpanded tail" } });
  const message = await host.notification(required(result.details?.taskId));
  expect(message.content).toContain("<result>original\nexpanded tail</result>");
  const tool = required(host.tools.get("SubagentWorkflow"));
  const compact = tool.renderResult(result, { expanded: false }, plainTheme, { isError: false }).render(80);
  expect(compact.length).toBeLessThanOrEqual(3);
  expect(compact.join("\n")).toContain("original");
  expect(compact.join("\n")).not.toContain("expanded tail");
  expect(tool.renderResult(result, { expanded: true }, plainTheme, { isError: false }).render(80).join("\n")).toContain("expanded tail");
  expect(host.api.sendMessage).toHaveBeenCalledTimes(1);
  expect(host.api.events.emit.mock.calls.some(([name]) => name === "subagents:completed")).toBe(false);
  expect(vi.mocked(runAgent).mock.calls[0][3].workflow).toBe(true);
  expect((await host.finish(result)).usage).toMatchObject({ input: 10, cacheRead: 7, cost: { total: 0.25 } });
  expect((await host.finish(result)).usage).toBeUndefined();
});

it("reuses omitted source and original args, and actually replays only an unchanged prefix", async () => {
  const host = boot({ workflowsEnabled: true });
  const first = await host.execute({ script: source, args: { prompt: "original" } });
  const firstId = required(first.details?.taskId);
  await host.notification(firstId);
  const resumed = await host.execute({ resumeFromRunId: firstId });
  expect((await host.notification(required(resumed.details?.taskId))).content).toContain("1 replayed");
  expect(runAgent).toHaveBeenCalledTimes(1);
  const changed = await host.execute({ resumeFromRunId: firstId, args: { prompt: "changed" } });
  expect((await host.notification(required(changed.details?.taskId))).content).toContain("<result>changed</result>");
  expect(runAgent).toHaveBeenCalledTimes(2);
  await expect(host.execute({ resumeFromRunId: "wf_unknown" })).rejects.toThrow("No workflow run");
});

it("does not claim replay when a journal has no recorded prefix", async () => {
  const host = boot({ workflowsEnabled: true });
  const first = await host.execute({ script: "export const meta={name:'empty',description:'empty'}; return args", args: "original" });
  const firstId = required(first.details?.taskId);
  await host.notification(firstId);
  const resumed = await host.execute({ resumeFromRunId: firstId });
  expect(resumed.content[0].text).toContain("Nothing to replay");
  expect((await host.notification(required(resumed.details?.taskId))).content).toContain("<result>original</result>");
});

it.each(["session_shutdown", "session_start"])("%s waits for owned teardown and suppresses stale completion", async (event) => {
  const host = boot({ workflowsEnabled: true });
  let finishChild: (() => void) | undefined;
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    await new Promise<void>(resolve => { finishChild = resolve; });
    return { responseText: "stopped", session, aborted: options.signal?.aborted ?? false, steered: false };
  });
  const result = await host.execute({ script: source, args: { prompt: "wait" } });
  await vi.waitFor(() => expect(finishChild).toBeDefined());
  let settled = false;
  const stopping = host.lifecycle(event).then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  required(finishChild)();
  await stopping;
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(host.api.sendMessage).not.toHaveBeenCalled();
  if (event === "session_shutdown") {
    expect((await host.execute({ resumeFromRunId: required(result.details?.taskId) })).content[0].text).toContain("unavailable");
  } else {
    await expect(host.execute({ resumeFromRunId: required(result.details?.taskId) })).rejects.toThrow("No workflow run");
  }
});

it("runs the CLI file once and writes one entry without triggering a turn", async () => {
  const host = boot({ workflowsEnabled: true });
  writeFileSync(join(dir, "workflow.js"), "export const meta={name:'cli',description:'test'}; return ['ok', 'entry tail'].join('\\n')");
  host.setFlag("workflow.js");
  await host.lifecycle("session_start");
  await vi.waitFor(() => expect(host.api.appendEntry).toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.objectContaining({ status: "completed" })));
  expect(host.api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "workflow-result", display: false }), { deliverAs: "nextTurn" });
  const data = required(host.api.appendEntry.mock.calls.find(([name]) => name === WORKFLOW_ENTRY_TYPE))[1];
  expect(data.value).toBe("ok\nentry tail");
  const renderer = required(host.api.registerEntryRenderer.mock.calls.find(([name]) => name === WORKFLOW_ENTRY_TYPE))[1];
  expect(renderer({ data }, { expanded: true }, plainTheme).render(80).join("\n")).toContain("entry tail");
  expect(renderer({ data }, { expanded: false }, plainTheme).render(80).join("\n")).not.toContain("entry tail");
  await host.lifecycle("session_start");
  expect(host.api.appendEntry).toHaveBeenCalledTimes(1);
});

it("stops discovering the authoring skill when startup collision handling disables workflows", async () => {
  const host = boot({ workflowsEnabled: true });
  vi.spyOn(await import("../src/workflow/collisions.js"), "decideWorkflowCollision").mockReturnValue({
    kind: "standDown", message: "fixture collision", withdraw: true,
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await host.lifecycle("session_start");
  expect(host.api.setActiveTools).toHaveBeenCalled();
  expect(await host.discover()).toEqual([undefined]);
});

it("rejects a bare workflow-file flag and reports same-name tool collisions", async () => {
  const host = boot({ workflowsEnabled: true });
  host.setFlag(true);
  host.setForeign([{ name: "SubagentWorkflow", description: "foreign" }]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await host.lifecycle("session_start");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("needs a path"));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("first registration"));
  expect(host.api.setActiveTools).not.toHaveBeenCalled();
});

describe("saved discovery and collision policy", () => {
  it("resolves project/workspace/global names, keeps explicit source precedence, and rejects traversal", () => {
    const roots = [join(dir, ".pi", "workflows"), join(dir, ".agents", "workflows"), join(dir, "global", "workflows")];
    for (const [index, root] of roots.entries()) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "named.js"), `export const meta={name:'${index}',description:'test'};return ${index}`);
    }
    writeFileSync(join(roots[0], "helper.js"), "throw new Error('must not execute')");
    symlinkSync(join(roots[0], "named.js"), join(roots[0], "linked.js"));
    expect(resolveWorkflowScript({ name: "linked" }, dir).ok).toBe(false);
    expect(listSavedWorkflows(dir)).toEqual(["named"]);
    expect(resolveWorkflowScript({ name: "named" }, dir)).toMatchObject({ ok: true, scriptPath: join(roots[0], "named.js") });
    expect(resolveWorkflowScript({ name: "named", script: source }, dir)).toMatchObject({ script: source });
    expect(resolveWorkflowScript({ scriptPath: join(roots[2], "named.js"), script: source }, dir)).toMatchObject({ script: readFileSync(join(roots[2], "named.js"), "utf-8") });
    expect(resolveWorkflowScript({ name: "../named" }, dir).ok).toBe(false);
    expect(resolveWorkflowScript({ name: "helper" }, dir).ok).toBe(false);
  });
  it.each(["Workflow", "workflow"])("detects exact %s names and honors explicit opt-in", (name) => {
    const input = { tools: [{ name, description: "foreign" }], ownDescription: "ours", pinned: false };
    expect(decideWorkflowCollision(input)).toMatchObject({ kind: "standDown", withdraw: true });
    expect(decideWorkflowCollision({ ...input, pinned: true }).kind).toBe("none");
    expect(decideWorkflowCollision({ ...input, tools: [{ name: `get_${name}`, description: "foreign" }] }).kind).toBe("none");
  });
});


it("hides owned children in the ordinary menu count and running-agent list", async () => {
  const host = boot({ workflowsEnabled: true });
  const workflow = await host.execute({ script: source, args: { prompt: "owned child" } });
  const id = workflow.details?.taskId;
  assert.ok(id);
  await host.notification(id);
  const agent = host.tools.get("Agent");
  assert.ok(agent);
  await agent.execute("ordinary", { subagent_type: "fixture", prompt: "ordinary", description: "ordinary" }, undefined, undefined, host.ctx);
  host.ui.select.mockImplementationOnce(async (_title, choices: string[]) => {
    const running = choices.find(choice => choice.startsWith("Running agents ("));
    expect(running).toContain("Running agents (1)");
    return running;
  }).mockImplementationOnce(async (title, choices: string[]) => {
    expect(title).toBe("Running agents");
    expect(choices).toHaveLength(1);
    expect(choices[0]).toContain("ordinary");
    expect(choices[0]).not.toContain("owned child");
    return undefined;
  });
  await host.commands.get("agents")?.handler("", host.ctx);
  expect(host.ui.select).toHaveBeenCalledTimes(3);
});

it("keeps registration, execution and menus enabled until reload after disabling the setting", async () => {
  const host = boot({ workflowsEnabled: true });
  host.ui.select.mockResolvedValueOnce("Settings");
  host.ui.custom.mockImplementation(async factory => {
    factory({}, {}, {}, () => {});
    settingsUI.change?.("workflowsEnabled", "off");
  });
  await host.commands.get("agents")?.handler("", host.ctx);
  expect(loadSettings(dir).workflowsEnabled).toBe(false);
  expect(host.ui.select.mock.calls.at(-1)?.[1]).toContain("Workflows (0)");
  const run = await host.execute({ script: "export const meta={name:'enabled',description:'enabled'}; return 'still enabled'" });
  const id = run.details?.taskId;
  assert.ok(id);
  expect((await host.notification(id)).content).toContain("still enabled");
  await host.lifecycle("session_shutdown");
  expect(boot({ ...loadSettings(dir) }).tools.has("SubagentWorkflow")).toBe(false);
});

it("initializes accounting before CLI workflow startup can deliver usage", async () => {
  let listener: Parameters<AgentManager["setUsageListener"]>[0];
  const setListener = AgentManager.prototype.setUsageListener;
  vi.spyOn(AgentManager.prototype, "setUsageListener").mockImplementation(function (this: AgentManager, next) {
    listener = next;
    setListener.call(this, next);
  });
  const createHost = workflowHost.createWorkflowHost;
  vi.spyOn(workflowHost, "createWorkflowHost").mockImplementation(options => {
    listener?.({ input: 9, output: 1, cacheWrite: 0 });
    return createHost(options);
  });
  const host = boot({ workflowsEnabled: true, reportUsage: true });
  writeFileSync(join(dir, "startup.js"), "export const meta={name:'startup',description:'startup'}; return 'ok'");
  host.setFlag("startup.js");
  await host.lifecycle("session_start");
  await vi.waitFor(() => expect(host.api.sendMessage).toHaveBeenCalled());
  expect((await host.finish({ content: [] })).usage?.input).toBe(9);
  expect((await host.finish({ content: [] })).usage).toBeUndefined();
});

it.each(["tool", "cli"])("%s completions expose the full oversized result through a readable artifact", async mode => {
  const host = boot({ workflowsEnabled: true });
  const full = "preview\n" + "x".repeat(5000) + "retained tail";
  const script = "export const meta={name:'long',description:'long'}; return " + JSON.stringify(full);
  if (mode === "cli") {
    writeFileSync(join(dir, "long.js"), script);
    host.setFlag("long.js");
    await host.lifecycle("session_start");
  } else {
    await host.execute({ script });
  }
  await vi.waitFor(() => expect(host.api.sendMessage).toHaveBeenCalled());
  const message = host.api.sendMessage.mock.calls[0][0];
  const path = message.content.match(/Full workflow result: (.+)/)?.[1];
  assert.ok(path);
  artifactDirs.add(dirname(path));
  expect(readFileSync(path, "utf-8")).toBe(full);
  expect(message.content).toContain("...(truncated)");
});

it("reports artifact write failures without losing the expanded result", async () => {
  const host = boot({ workflowsEnabled: true });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const full = "preview\n" + "x".repeat(5000) + "retained tail";
  const result = await host.execute({ script: "export const meta={name:'long',description:'long'}; return " + JSON.stringify(full) });
  const id = result.details?.taskId;
  const scriptPath = result.content[0].text?.match(/Script: (.+)/)?.[1];
  assert.ok(id); assert.ok(scriptPath);
  mkdirSync(join(dirname(scriptPath), `${id}.workflow-result.txt`));
  const message = await host.notification(id);
  expect(message.content).toContain("Warning: Full workflow result could not be saved");
  expect(warn).toHaveBeenCalled();
  const tool = host.tools.get("SubagentWorkflow");
  assert.ok(tool);
  expect(tool.renderResult(result, { expanded: true }, plainTheme, { isError: false }).render(80).join("\n")).toContain("retained tail");
});

it("diagnoses a failed collision check instead of silently ignoring it", async () => {
  const host = boot({ workflowsEnabled: true });
  vi.spyOn(host.api, "getAllTools").mockImplementation(() => { throw new Error("registry failure"); });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await host.lifecycle("session_start");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Workflow collision check failed"));
  expect(host.tools.has("SubagentWorkflow")).toBe(true);
});

const inputScript = "export const meta={name:'input',description:'input',inputSchema:{type:'object',properties:{message:{type:'string',pattern:'\\\\S'}},required:['message'],additionalProperties:false}};";

it.each([
  { script: source + " const broken = ;", args: { prompt: 'no launch' }, error: /Unexpected token/ },
  { script: inputScript + 'return args.message', args: { message: 42 }, error: /args/ },
  { script: inputScript + 'return args.message', args: { message: '   ' }, error: /args/ },
])('rejects admission before artifacts or launches: $args', async ({ script, args, error }) => {
  const host = boot({ workflowsEnabled: true });
  const createHost = vi.spyOn(workflowHost, 'createWorkflowHost');
  const allocate = vi.spyOn(workflowTask, 'workflowRunId');
  const persist = vi.spyOn(outputFile, 'createOutputFilePath');
  await expect(host.execute({ script, args })).rejects.toThrow(error);
  expect(allocate).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
  expect(createHost).not.toHaveBeenCalled();
  expect(runAgent).not.toHaveBeenCalled();
  expect(host.api.sendMessage).not.toHaveBeenCalled();
  host.ui.select.mockResolvedValueOnce(undefined);
  await required(host.commands.get('agents')).handler('', host.ctx);
  expect(host.ui.select.mock.calls.at(-1)?.[1]).toContain('Workflows (0)');
});

it('admits valid inputs, preserves effective resume args, and leaves body throws asynchronous', async () => {
  const host = boot({ workflowsEnabled: true });
  const first = await host.execute({ script: inputScript + 'return await Promise.resolve(args.message)', args: { message: 'valid' } });
  const id = required(first.details?.taskId);
  expect((await host.notification(id)).content).toContain('<result>valid</result>');
  const resumed = await host.execute({ resumeFromRunId: id });
  expect((await host.notification(required(resumed.details?.taskId))).content).toContain('<result>valid</result>');
  await expect(host.execute({ resumeFromRunId: id, args: null })).rejects.toThrow(/args/);
  const scalar = "export const meta={name:'null',description:'null',inputSchema:{type:'null'}}; return args;";
  await expect(host.execute({ resumeFromRunId: id, script: scalar })).rejects.toThrow(/args/);
  const overridden = await host.execute({ resumeFromRunId: id, script: scalar, args: null });
  await host.notification(required(overridden.details?.taskId));
  const dynamic = await host.execute({ script: inputScript + "throw new Error('runtime')", args: { message: 'valid' } });
  expect((await host.notification(required(dynamic.details?.taskId))).content).toContain('runtime');
});

it.each([{}, { scriptPath: 'missing.js' }, { name: '../invalid' }, { script: 'return 1' },
  { script: source + '\u0000' }, { script: source + ' '.repeat(524_288) },
  { script: "export const meta={name:'bad',description:'bad',inputSchema:[]}; return 1" },
])('rejects source and static admission errors: %s', async params => {
  const host = boot({ workflowsEnabled: true });
  const allocate = vi.spyOn(workflowTask, 'workflowRunId');
  await expect(host.execute(params)).rejects.toThrow();
  expect(allocate).not.toHaveBeenCalled();
  expect(runAgent).not.toHaveBeenCalled();
  expect(host.api.sendMessage).not.toHaveBeenCalled();
});
