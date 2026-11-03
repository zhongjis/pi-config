import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { registerBtwExtension } from "../index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { ContextStore } from "../src/context-store.ts";
import { createPayload } from "../src/core.ts";
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const layout = (terminal = "t-current", pane = "p-current", id = "tab") => JSON.stringify({ spaces: [{ tabs: [{ id, name: "1", terminals: [{ terminal, pane }] }] }] });
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "btw-app-"));
  vi.stubEnv("HC_TERMINAL_ID", "t-current");
  vi.stubEnv("HERDR_ENV", "1");
  vi.stubEnv("HERDR_PANE_ID", "stale-native");
  vi.stubEnv("ORCA_TERMINAL_HANDLE", "stale-orca");
  vi.stubEnv("PI_HERDR_BTW_PAYLOAD", "");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function launch(result: ReturnType<typeof ok> & { killed?: boolean }, stdout = layout()) {
  const mock = createMockPi();
  const exec = vi.fn(async (_command: string, args: string[]) => args[0] === "ls" ? ok(stdout) : result);
  Object.assign(mock.pi, { exec });
  const store = new ContextStore(root);
  const remove = vi.spyOn(store, "remove");
  const create = vi.spyOn(store, "create");
  const notify = vi.fn();
  await Reflect.apply(registerBtwExtension, undefined, [mock.pi, { store, configStore: { load: async () => ({ ...DEFAULT_CONFIG }), save: async () => {}, reset: async () => ({ ...DEFAULT_CONFIG }) } }]);
  const ctx = { mode: "tui", ui: { notify }, cwd: root, model: { provider: "test", id: "model" }, getSystemPrompt: () => "parent", isIdle: () => true,
    sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined, getLeafId: () => null, getEntries: () => [{ type: "message", message: { role: "user", content: "hello" } }] } };
  await mock.fireLifecycle("session_start", {}, ctx);
  const command = mock.commands.get("btw");
  if (!command || typeof command !== "object" || !("handler" in command) || typeof command.handler !== "function") throw new Error("Expected btw command");
  await Reflect.apply(command.handler, command, ["question", ctx]);
  await mock.fireLifecycle("session_shutdown");
  return { exec, remove, create, notify };
}

describe("herdr-app side threads", () => {
  it("launches from the exact HC-associated pane with positional cwd and payload", async () => {
    const { exec, create, remove } = await launch(ok('{"pane":"p-child","terminal":"t-child"}'));
    expect(create.mock.calls[0]?.[0].parentPaneId).toBe("p-current");
    expect(exec.mock.calls.map(call => call[0])).toEqual(["herdr-app", "herdr-app"]);
    const args = exec.mock.calls[1]?.[1] ?? [];
    expect(args.slice(0, 4)).toEqual(["do", "pane.split", "--pane", "p-current"]);
    const argv = JSON.parse(args[7] ?? "[]");
    expect(argv.slice(0, 5)).toEqual(["sh", "-c", 'cd -- "$1" && shift && exec "$@"', "pi-pane", root]);
    expect(argv[6]).toMatch(/^PI_HERDR_BTW_PAYLOAD=/);
    expect(argv[7]).toBe("pi");
    expect(remove).not.toHaveBeenCalled();
  });
  it.each(["{}", "not json", layout("t-unmatched")])("does not launch without an exact valid layout", async stdout => {
    const { exec, create } = await launch(ok(), stdout);
    expect(exec.mock.calls.map(call => call[1])).toEqual([["ls"]]);
    expect(create).not.toHaveBeenCalled();
  });
  it.each([ok("{}"), { ...ok(), code: 1, killed: true }])("retains payload after an unknown split outcome", async result => {
    const { exec, remove, notify } = await launch(result);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(remove).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("unknown"), "warning");
  });
  it("cleans up a definitely rejected split", async () => {
    const { remove } = await launch({ code: 1, stdout: "", stderr: "rejected" });
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it.each([
    { matched: true, stdout: layout() },
    { matched: false, stdout: layout("t-other") },
    { matched: false, stdout: layout("t-current", "p-current", "") },
    { matched: false, stdout: layout("") },
    { matched: false, stdout: layout("t-current", "") },
  ])("child shutdown resolves own terminal before close: %j", async ({ matched, stdout }) => {
    const store = new ContextStore(root);
    vi.stubEnv("PI_HERDR_BTW_PAYLOAD", await store.create(createPayload({ createdAt: "now", parentSessionId: "s", parentPaneId: "p-parent",
      metadata: { generatedAt: "now", cwd: root, session: "s", model: "test/model" }, parentSystemPrompt: null, parentActiveTools: [], parentThinkingLevel: "medium",
      messages: [], draftQuestion: "", config: { ...DEFAULT_CONFIG, closeOnExit: true } })));
    const mock = createMockPi();
    const exec = vi.fn(async (_command: string, args: string[]) => ok(args[0] === "ls" ? stdout : ""));
    Object.assign(mock.pi, { exec });
    await Reflect.apply(registerBtwExtension, undefined, [mock.pi, { store }]);
    await mock.fireLifecycle("session_shutdown", { reason: "quit" }, { mode: "tui" });
    expect(exec.mock.calls.map(call => [call[0], call[1]])).toEqual(matched ? [
      ["herdr-app", ["ls"]], ["herdr-app", ["do", "pane.focus", "--pane", "p-parent"]], ["herdr-app", ["do", "pane.close", "--pane", "p-current"]],
    ] : [["herdr-app", ["ls"]]]);
  });
});
