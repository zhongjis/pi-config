/**
 * codemode-builtin.e2e.test.ts — Pi's built-in codemode in subagents.
 *
 * `builtin:codemode` loads only through `extensions:` rules, like every other
 * extension; loading grants nothing. `tools:` only permits: Pi activates
 * `codemode` (registered `defaultActive: false`) only when the `defaultTools`
 * setting names it. Nested tool calls (how codemode scripts reach tools) can
 * only call tools the agent's `tools:` rules grant, even inactive
 * `codemode`-exposure tools.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAccessRules } from "../../../lib/active-tools.js";
import { disposeChildSession } from "../../src/agent-manager.js";
import { runAgent } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";
import type { AgentConfig } from "../../src/types.js";
import { createFauxModelRuntime, type FauxModelRuntime } from "../helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

const RAN = Symbol.for("subagents-e2e:codemode-ran");
const OUTCOMES = Symbol.for("subagents-e2e:codemode-outcomes");
type ProbeGlobal = Record<symbol, string[]>;

function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
}

describe("built-in codemode in subagents against real pi-mono", () => {
  let cwd: string;
  let fauxRuntime: FauxModelRuntime;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-codemode-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent-dir"));
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "extensions", "code-probe.ts"), `
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const g = globalThis as Record<symbol, string[]>;
const ran = () => (g[Symbol.for("subagents-e2e:codemode-ran")] ??= []);
const outcomes = () => (g[Symbol.for("subagents-e2e:codemode-outcomes")] ??= []);

function codeTool(name: string) {
  return defineTool({
    name,
    label: name,
    description: \`Codemode-exposure probe \${name}.\`,
    parameters: Type.Object({}),
    exposure: "codemode",
    execute: async () => { ran().push(name); return { content: [{ type: "text" as const, text: name }], details: {} }; },
  });
}

export default function(pi: ExtensionAPI) {
  pi.registerTool(codeTool("code_allowed"));
  pi.registerTool(codeTool("code_denied"));
  pi.registerTool(defineTool({
    name: "run_nested",
    label: "run_nested",
    description: "Calls another tool the way a codemode script does.",
    parameters: Type.Object({ name: Type.String() }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const outcome = await ctx.executeTool(params.name, {});
      outcomes().push(\`\${params.name}:\${outcome.isError ? "error" : "ok"}\`);
      return { content: [{ type: "text" as const, text: "nested" }], details: {} };
    },
  }));
}
`);
    (globalThis as ProbeGlobal)[RAN] = [];
    (globalThis as ProbeGlobal)[OUTCOMES] = [];
    fauxRuntime = await createFauxModelRuntime({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    fauxRuntime.dispose();
    vi.unstubAllEnvs();
    delete (globalThis as ProbeGlobal)[RAN];
    delete (globalThis as ProbeGlobal)[OUTCOMES];
    rmSync(cwd, { recursive: true, force: true });
  });

  async function run(extensions: string, tools: string, options: { isolated?: boolean; probeVeto?: boolean } = {}) {
    registerAgents(new Map([["coder", {
      name: "coder",
      description: "coder",
      extensionRules: parseAccessRules("extensions", extensions).rules,
      toolRules: parseAccessRules("tools", tools).rules,
      discoverSkills: false,
      preloadSkills: [],
      systemPrompt: "You are coder.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    } satisfies AgentConfig]]));
    const { model, modelRegistry } = fauxRuntime;
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", model, modelRegistry, isProjectTrusted: () => true };
    let session: any;
    let active: string[] = [];
    try {
      await runAgent(ctx, "coder", "go", {
        pi: makePi(),
        model,
        isolated: options.isolated,
        onSessionCreated: (s) => { session = s; active = s.getActiveToolNames(); },
      });
    } catch {
      // The faux turn may fail; loading and scope are fixed at construction.
    }
    const paths: string[] = session.extensionRunner.getExtensionPaths();
    const veto = options.probeVeto ? await session.agent.beforeToolCall({ toolCall: { name: "codemode" }, args: {} }) : undefined;
    await disposeChildSession(session);
    return { active, loaded: paths.includes("builtin:codemode"), veto };
  }

  it("tools: +codemode permits codemode but does not activate it", async () => {
    const { loaded, active } = await run("+builtin:codemode", "+read, +codemode");
    expect({ loaded, codemode: active.includes("codemode") }).toEqual({ loaded: true, codemode: false });
  });

  it("defaultTools +codemode activates codemode and tools: +codemode permits it", async () => {
    mkdirSync(join(cwd, "agent-dir"), { recursive: true });
    writeFileSync(join(cwd, "agent-dir", "settings.json"), JSON.stringify({ defaultTools: ["+codemode"] }));
    const { loaded, active, veto } = await run("+builtin:codemode", "+read, +codemode", { probeVeto: true });
    expect({ loaded, codemode: active.includes("codemode"), codeAllowed: active.includes("code_allowed"), veto })
      .toEqual({ loaded: true, codemode: true, codeAllowed: false, veto: undefined });
  });

  it("+builtin:codemode without a codemode grant loads it but leaves codemode inactive", async () => {
    const { loaded, active } = await run("+builtin:codemode", "+read");
    expect({ loaded, codemode: active.includes("codemode") }).toEqual({ loaded: true, codemode: false });
  });

  it("vetoes a codemode call the tools: rules do not grant", async () => {
    const { veto } = await run("+builtin:codemode", "+read", { probeVeto: true });
    expect(veto).toMatchObject({ block: true, reason: 'Tool "codemode" is not available to this subagent.' });
  });

  it("-builtin:codemode after +@all leaves codemode unloaded", async () => {
    const { loaded } = await run("+@all, -builtin:codemode", "+read, +codemode");
    expect(loaded).toBe(false);
  });

  it("isolated loads no builtin:codemode", async () => {
    const { loaded } = await run("+builtin:codemode", "+read, +codemode", { isolated: true });
    expect(loaded).toBe(false);
  });

  it("nested calls reach granted codemode-exposure tools and block the rest", async () => {
    fauxRuntime.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("run_nested", { name: "code_denied" }),
        fauxToolCall("run_nested", { name: "code_allowed" }),
      ]),
      fauxAssistantMessage([fauxText("done")]),
    ]);

    await run("+builtin:codemode, +code-probe", "+codemode, +run_nested, +code_allowed");

    expect({ ran: (globalThis as ProbeGlobal)[RAN], outcomes: [...(globalThis as ProbeGlobal)[OUTCOMES]].sort() })
      .toEqual({ ran: ["code_allowed"], outcomes: ["code_allowed:ok", "code_denied:error"] });
  });
});
