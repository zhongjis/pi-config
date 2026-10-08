/**
 * agent-runner-e2e.test.ts — End-to-end test against the REAL pi-mono runtime.
 *
 * Every other agent-runner test mocks `@earendil-works/pi-coding-agent`: it
 * asserts that `runAgent` hands the right `tools:` allowlist to a *simulated*
 * `createAgentSession`. That proves our allowlist math, but not the assumption
 * the math rests on — that real pi-mono actually gates a session to that
 * allowlist, admitting extension-registered tools (the #47 fix) and dropping
 * the rest.
 *
 * This test closes that loop with NO pi-mono mock:
 *   - a real extension fixture (`fixtures/e2e-probe-ext.mjs`) registers a tool,
 *   - the real `DefaultResourceLoader` discovers it as the project extension
 *     `e2e-probe` and `extensions:` rules select it,
 *   - the real `createAgentSession` builds the session,
 *   - we read the real `session.getActiveToolNames()` at `onSessionCreated`
 *     (fires after construction, before any prompt) and assert what the LLM
 *     would actually be allowed to call.
 *
 * No network: a native faux provider on a per-test `ModelRuntime` satisfies
 * `createAgentSession`; assertions inspect the gated tool set at construction.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAccessRules } from "../../lib/active-tools.js";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";
import { createFauxModelRuntime, type FauxModelRuntime } from "./helpers/pi-ai.js";

// These tests spin up the REAL pi-mono runtime (loader + dynamic extension
// import + session construction), so a cold first run under full-suite CPU
// contention can exceed vitest's 5s default. Give the file generous headroom —
// a genuine hang still fails, just later.
vi.setConfig({ testTimeout: 30_000 });

const FIXTURE = resolve(fileURLToPath(new URL("./fixtures/e2e-probe-ext.mjs", import.meta.url)));
/** The fixture registers exactly this tool. */
const EXT_TOOL = "e2e_probe";
/** Pi's four default-active built-ins — the ones it auto-activates with no `tools:` option set. */
const DEFAULT_ACTIVE_BUILTINS = ["read", "bash", "edit", "write"];

/** Minimal `pi` stub — `detectEnv` only needs `exec` (returns non-git). */
function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
}

describe("agent-runner end-to-end (real pi-mono session + real extension)", () => {
  let cwd: string;
  let fauxRuntime: FauxModelRuntime;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-e2e-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent-dir"));
    // Discovered project extension `e2e-probe`, re-exporting the fixture.
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "extensions", "e2e-probe.ts"), `export { default } from ${JSON.stringify(FIXTURE)};\n`);
    fauxRuntime = await createFauxModelRuntime({
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 200_000 }],
    });
  });
  afterEach(() => {
    fauxRuntime.dispose();
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  /**
   * Register an agent type "e2e" with the given `extensions:` / `tools:` rules,
   * run it through the REAL runAgent, and return the real session plus its
   * active tool names captured at construction time.
   */
  async function runFor(extensions: string, tools: string): Promise<{ session: AgentSession | undefined; active: string[] }> {
    registerAgents(
      new Map([
        [
          "e2e",
          {
            name: "e2e",
            description: "e2e",
            extensionRules: parseAccessRules("extensions", extensions).rules,
            toolRules: parseAccessRules("tools", tools).rules,
            discoverSkills: false,
            preloadSkills: [],
            systemPrompt: "You are e2e.",
            promptMode: "replace",
            inheritContext: false,
            runInBackground: false,
            isolated: false,
          } satisfies AgentConfig,
        ],
      ]),
    );
    const { model, modelRegistry } = fauxRuntime;
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", model, modelRegistry };

    let session: AgentSession | undefined;
    let active: string[] = [];
    try {
      await runAgent(ctx, "e2e", "go", {
        pi: makePi(),
        model,
        onSessionCreated: (s) => {
          session = s;
          active = s.getActiveToolNames();
        },
      });
    } catch {
      // A no-op/erroring prompt turn is fine — the gated tool set is fixed at
      // construction, which `onSessionCreated` already captured.
    }
    return { session, active };
  }

  async function activeToolsFor(extensions: string, tools: string): Promise<string[]> {
    return (await runFor(extensions, tools)).active;
  }

  it("real pi-mono admits an extension-registered tool when it's granted (#47)", async () => {
    const active = await activeToolsFor("+e2e-probe", "+@all");
    // The extension actually loaded and its tool reached the live session.
    expect(active).toContain(EXT_TOOL);
    // `tools: +@all` grants grep/find/ls too, but Pi only auto-activates its
    // four default built-ins — no `tools:` rule can turn on a default-off tool.
    for (const b of DEFAULT_ACTIVE_BUILTINS) expect(active).toContain(b);
  });

  it("an extension tool is absent when its extension does not load", async () => {
    const active = await activeToolsFor("", "+@all");
    expect(active).not.toContain(EXT_TOOL);
    // No `extensions:` grant → the static allowlist path: `tools:` becomes the
    // session's explicit `tools` option, so Pi activates exactly what it grants.
    for (const b of ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]) expect(active).toContain(b);
  });

  it("a loaded extension's tool stays active but is hidden and vetoed when tools: grants only built-ins", async () => {
    const { session, active } = await runFor("+e2e-probe", "+@builtin");
    // Pi activates the registered tool regardless of `tools:` — permission only.
    expect(active).toContain(EXT_TOOL);
    expect(active).toContain("read");
    // The veto still blocks a call to it.
    await expect(
      session?.agent.beforeToolCall?.({ toolCall: { name: EXT_TOOL } } as any),
    ).resolves.toMatchObject({ block: true });
  });

  it("tool rules veto a loaded-but-ungranted tool in real pi-mono", async () => {
    // Extension loads, but granting a different tool keeps this one ungranted
    // even though its extension loaded and ran its handlers.
    const { session, active } = await runFor("+e2e-probe", "+@builtin, +not_the_fixture");
    expect(active).toContain(EXT_TOOL);
    for (const b of DEFAULT_ACTIVE_BUILTINS) expect(active).toContain(b);
    await expect(
      session?.agent.beforeToolCall?.({ toolCall: { name: EXT_TOOL } } as any),
    ).resolves.toMatchObject({ block: true });
  });

  it("a tool grant surfaces the selected loaded tool", async () => {
    const active = await activeToolsFor("+e2e-probe", `+read, +${EXT_TOOL}`);
    expect(active).toContain(EXT_TOOL); // granted → surfaces
    expect(active).toContain("read");
    expect(active).not.toContain("bash"); // only read among built-ins
  });
});
