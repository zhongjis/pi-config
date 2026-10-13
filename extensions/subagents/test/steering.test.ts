import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async (importOriginal) =>
  (await import("./helpers/session-seam.js")).mockOpenSession(await importOriginal()));

let viewerSteer: ((message: string) => void) | undefined;
vi.mock("../src/ui/conversation-viewer.js", () => ({
  VIEWPORT_HEIGHT_PCT: 90,
  ConversationViewer: class {
    constructor(...args: ConstructorParameters<typeof import("../src/ui/conversation-viewer.js").ConversationViewer>) {
      viewerSteer = args[8];
    }
  },
}));

import { AgentManager } from "../src/agent-manager.js";
import { createAgentResultBuilder } from "../src/agent-result.js";
import { openSession } from "../src/agent-runner.js";
import { createResultTools } from "../src/result-tools.js";
import { openConversationOverlay } from "../src/ui/conversation-overlay.js";
import { deferred, fakeSession, flush, opened } from "./helpers/session-seam.js";

const emit = vi.fn();
const pi = { events: { emit } } as unknown as ExtensionAPI;
const ctx = { cwd: "/tmp" } as ExtensionContext;
let manager: AgentManager;

beforeEach(() => {
  manager = new AgentManager(undefined, 1);
  emit.mockClear();
  vi.mocked(openSession).mockReset();
  viewerSteer = undefined;
});
afterEach(async () => { await manager.dispose(); });

function tools() {
  const details = createAgentResultBuilder(() => false);
  return createResultTools(pi, manager, {
    cancelNudge: vi.fn(),
    details: record => details({ displayName: "worker", description: "worker", subagentType: "worker" }, record),
  }, { retrieve: vi.fn() });
}

it("routes queued tool steering through the manager and emits the acceptance event", async () => {
  const session = fakeSession(async (_prompt, child) => { await child.aborted; return "done"; });
  vi.mocked(openSession).mockResolvedValue(opened(session));
  const busy = manager.spawn(pi, ctx, "worker", "busy", { description: "busy", isBackground: true });
  const id = manager.spawn(pi, ctx, "worker", "queued", { description: "queued", isBackground: true });
  const steer = vi.spyOn(manager, "steer");
  const result = await tools().steer.execute("steer", { agent_id: id, message: "queued message" }, undefined, undefined, ctx);
  expect(steer).toHaveBeenCalledExactlyOnceWith(id, "queued message");
  expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/^Steering message queued/) }]);
  expect(emit).toHaveBeenCalledExactlyOnceWith("subagents:steered", { id, message: "queued message" });
  expect(session.steer).not.toHaveBeenCalled();
  manager.abort(id);
  expect(manager.getRecord(id)?.pendingSteers).toBeUndefined();
  await flush();
  manager.abort(busy);
  await manager.getRecord(busy)?.promise;
});

it("reports the original delivery rejection from tool steering without emitting success", async () => {
  const session = fakeSession(async (_prompt, child) => { await child.aborted; return "done"; });
  session.steer.mockRejectedValueOnce(new Error("original SDK failure"));
  vi.mocked(openSession).mockResolvedValueOnce(opened(session));
  const id = manager.spawn(pi, ctx, "worker", "go", { description: "worker", isBackground: true });
  await flush();
  const steer = vi.spyOn(manager, "steer");
  const result = await tools().steer.execute("steer", { agent_id: id, message: "redirect" }, undefined, undefined, ctx);
  expect(steer).toHaveBeenCalledExactlyOnceWith(id, "redirect");
  expect(result.content).toEqual([{ type: "text", text: "Failed to steer agent: original SDK failure" }]);
  expect(emit).not.toHaveBeenCalled();
  manager.abort(id);
  await manager.getRecord(id)?.promise;
});

it("routes overlay steering through the manager and notifies rejection and refusal", async () => {
  const drain = deferred<string>();
  const session = fakeSession(() => drain.promise);
  session.steer.mockRejectedValueOnce(new Error("UI SDK failure"));
  vi.mocked(openSession).mockResolvedValueOnce(opened(session));
  const id = manager.spawn(pi, ctx, "worker", "go", { description: "worker", isBackground: true });
  await flush();
  const record = manager.getRecord(id);
  if (!record) throw new Error("Missing record");
  const notify = vi.fn();
  const custom = vi.fn(async (factory: (tui: object, theme: object, keybindings: object, done: () => void) => unknown) => {
    factory({}, {}, {}, () => {});
  });
  const steer = vi.spyOn(manager, "steer");
  try {
    await openConversationOverlay({ notify, custom }, record, { manager, agentActivity: new Map() });
    if (!viewerSteer) throw new Error("Missing viewer steering callback");
    viewerSteer("redirect");
    await flush();
    expect(steer).toHaveBeenCalledExactlyOnceWith(id, "redirect");
    expect(notify).toHaveBeenCalledWith("Failed to steer agent: UI SDK failure", "error");
    manager.abort(id);
    viewerSteer("after stop");
    expect(notify).toHaveBeenCalledWith('Agent "worker" cannot accept steering.', "warning");
  } finally { drain.resolve("done"); await record.promise; }
});
