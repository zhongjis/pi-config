/**
 * child-session-lifecycle.e2e.test.ts — real Pi child sessions honor the
 * parent's project trust and receive `session_shutdown` exactly once on disposal.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAccessRules } from "../../../lib/active-tools.js";
import { disposeChildSession } from "../../src/agent-manager.js";
import { runAgent } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";
import type { AgentConfig } from "../../src/types.js";
import { createFauxModelRuntime, type FauxModelRuntime } from "../helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

const SHUTDOWN_COUNT = Symbol.for("subagents-e2e:shutdown-count");

function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
}

function registerProbeAgent(extensions: string): void {
  registerAgents(new Map([["probe", {
    name: "probe",
    description: "probe",
    extensionRules: parseAccessRules("extensions", extensions).rules,
    toolRules: parseAccessRules("tools", "+read").rules,
    discoverSkills: false,
    preloadSkills: [],
    systemPrompt: "You are probe.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  } as AgentConfig]]));
}

describe("child session lifecycle against real pi-mono", () => {
  let cwd: string;
  let fauxRuntime: FauxModelRuntime;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-lifecycle-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent-dir"));
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "extensions", "lifecycle-probe.ts"), `
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function(pi: ExtensionAPI) {
  pi.registerTool(defineTool({
    name: "project_probe",
    label: "project_probe",
    description: "Project-local probe tool.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
  }));
  pi.on("session_shutdown", () => {
    const key = Symbol.for("subagents-e2e:shutdown-count");
    (globalThis as Record<symbol, number>)[key] = ((globalThis as Record<symbol, number>)[key] ?? 0) + 1;
  });
}
`);
    (globalThis as Record<symbol, number>)[SHUTDOWN_COUNT] = 0;
    fauxRuntime = await createFauxModelRuntime({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    fauxRuntime.dispose();
    vi.unstubAllEnvs();
    delete (globalThis as Record<symbol, number>)[SHUTDOWN_COUNT];
    rmSync(cwd, { recursive: true, force: true });
  });

  async function spawn(projectTrusted: boolean | undefined): Promise<any> {
    registerProbeAgent("+@all, -@builtin");
    const { model, modelRegistry } = fauxRuntime;
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", model, modelRegistry };
    if (projectTrusted !== undefined) ctx.isProjectTrusted = () => projectTrusted;
    let session: any;
    try {
      await runAgent(ctx, "probe", "go", { pi: makePi(), model, onSessionCreated: (s) => { session = s; } });
    } catch {
      // The faux turn may fail; the session is fixed at construction.
    }
    return session;
  }

  it("an untrusted parent's child loads no project extensions", async () => {
    const untrusted = await spawn(false);
    expect(untrusted.getAllTools().map((t: { name: string }) => t.name)).not.toContain("project_probe");
    await disposeChildSession(untrusted);

    const trusted = await spawn(true);
    expect(trusted.getAllTools().map((t: { name: string }) => t.name)).toContain("project_probe");
    await disposeChildSession(trusted);
  });

  it("emits session_shutdown exactly once before disposing the child", async () => {
    const session = await spawn(undefined);
    const dispose = vi.spyOn(session, "dispose");

    await Promise.all([disposeChildSession(session), disposeChildSession(session)]);
    await disposeChildSession(session);

    expect((globalThis as Record<symbol, number>)[SHUTDOWN_COUNT]).toBe(1);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
