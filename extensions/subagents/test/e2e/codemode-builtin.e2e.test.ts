/**
 * codemode-builtin.e2e.test.ts — Pi's built-in codemode in subagents.
 *
 * An exact `codemode` extension_tools entry loads `builtin:codemode` and activates its
 * model-only tool; omitted/wildcard selections, isolation, and `extensions: false` do not.
 * Nested tool calls (how codemode scripts reach tools) can only call tools the
 * agent's policy reaches, even inactive `codemode`-exposure tools.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  async function run(cfg: Partial<AgentConfig>, isolated = false) {
    registerAgents(new Map([["coder", {
      name: "coder",
      description: "coder",
      builtinToolNames: ["read"],
      extensions: true,
      discoverSkills: false,
      preloadSkills: [],
      systemPrompt: "You are coder.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      ...cfg,
    } as AgentConfig]]));
    const { model, modelRegistry } = fauxRuntime;
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", model, modelRegistry, isProjectTrusted: () => true };
    const diagnostics: string[] = [];
    let session: any;
    let active: string[] = [];
    try {
      await runAgent(ctx, "coder", "go", {
        pi: makePi(),
        model,
        isolated,
        onSessionCreated: (s) => { session = s; active = s.getActiveToolNames(); },
        onToolActivity: (a) => { if (a.type === "diagnostic") diagnostics.push(a.toolName); },
      });
    } catch {
      // The faux turn may fail; loading and scope are fixed at construction.
    }
    const paths: string[] = session.extensionRunner.getExtensionPaths();
    await disposeChildSession(session);
    return { active, paths, diagnostics };
  }

  it("exact `codemode` loads builtin:codemode and activates its tool", async () => {
    const { active, paths } = await run({ extensionToolNames: ["codemode", "run_nested"] });
    expect(paths).toContain("builtin:codemode");
    expect(active).toContain("codemode");
    expect(active).not.toContain("code_allowed");
  });

  it.each([
    ["omitted extension_tools", {}],
    ["wildcard extension_tools", { extensionToolNames: ["*"] }],
    ["codemode prefix wildcard", { extensionToolNames: ["code*"] }],
  ])("%s loads no builtin:codemode", async (_label, cfg) => {
    const { paths, active } = await run(cfg);
    expect(paths).not.toContain("builtin:codemode");
    expect(active).not.toContain("codemode");
  });

  it.each([
    ["isolated", {}, true],
    ["extensions: false", { extensions: false as const }, false],
  ])("%s loads no builtin:codemode and reports the listing", async (_label, cfg, isolated) => {
    const { paths, diagnostics } = await run({ extensionToolNames: ["codemode"], ...cfg }, isolated);
    expect(paths).not.toContain("builtin:codemode");
    expect(diagnostics.some((d) => d.includes('"codemode" has no effect'))).toBe(true);
  });

  it("exclude_extensions: builtin:codemode disables it without a typo warning", async () => {
    const { paths, diagnostics } = await run({ extensionToolNames: ["codemode"], excludeExtensions: ["builtin:codemode"] });
    expect(paths).not.toContain("builtin:codemode");
    expect(diagnostics.filter((d) => d.includes("exclude_extensions"))).toEqual([]);
  });

  it("csv `extensions:` keeps builtin:codemode", async () => {
    const { paths, active } = await run({ extensions: ["code-probe"], extensionToolNames: ["codemode"] });
    expect(paths).toContain("builtin:codemode");
    expect(active).toContain("codemode");
  });

  it("nested calls reach allowlisted codemode-exposure tools and block the rest", async () => {
    fauxRuntime.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("run_nested", { name: "code_denied" }),
        fauxToolCall("run_nested", { name: "code_allowed" }),
      ]),
      fauxAssistantMessage([fauxText("done")]),
    ]);

    await run({ extensionToolNames: ["codemode", "run_nested", "code_allowed"] });

    expect((globalThis as ProbeGlobal)[RAN]).toEqual(["code_allowed"]);
    expect([...(globalThis as ProbeGlobal)[OUTCOMES]].sort()).toEqual(["code_allowed:ok", "code_denied:error"]);
  });
});
