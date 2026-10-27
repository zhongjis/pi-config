import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { boot, dir, openSessionMock, required } from "./graph-run-registration.fixture.js";

it.each([false, true])("denies unknown and disabled agent targets with an active mode: %s", async (activeMode) => {
  writeFileSync(join(dir, ".pi", "agents", "disabled.md"), "---\ndescription: Disabled\nenabled: false\n---\nFixture");
  const host = boot();
  if (activeMode) {
    host.ctx.sessionManager.getEntries = () => [{
      type: "custom", customType: "agent-mode", id: "mode", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
      data: { mode: "fixture-mode", delegationPolicy: { version: 2, rules: [{ sign: "+", selector: "@all" }] } },
    }];
  }
  await host.lifecycle("session_start");
  for (const type of ["missing", "disabled"]) {
    const result = await required(host.tools.get("agent")).execute("call", {
      subagent_type: type, prompt: "task", description: "test",
    }, undefined, undefined, host.ctx);

    expect(result).toMatchObject({ details: {
      category: "delegation_policy_denied", requestedType: type, permittedTypes: ["fixture"],
    } });
    expect(openSessionMock).not.toHaveBeenCalled();
  }
});

it("runs the canonical loaded agent without an active mode", async () => {
  const host = boot();
  const result = await required(host.tools.get("agent")).execute("call", {
    subagent_type: " FIXTURE ", prompt: "task", description: "test",
  }, undefined, undefined, host.ctx);

  expect(result).toMatchObject({ details: { subagentType: "fixture", status: "completed" } });
  expect(openSessionMock.mock.calls[0]?.[1]).toBe("fixture");
});

it("denies unknown targets through the published manager bridge", async () => {
  const host = boot();
  await host.lifecycle("session_start");
  const bridge: unknown = Reflect.get(globalThis, Symbol.for("pi-subagents:manager"));
  if (typeof bridge !== "object" || bridge === null || !("spawn" in bridge) || typeof bridge.spawn !== "function") {
    throw new Error("Manager bridge was not published");
  }

  const spawn = bridge.spawn;
  expect(() => spawn(host.api, host.ctx, "missing", "task", {})).toThrow("delegation_policy_denied");
  expect(openSessionMock).not.toHaveBeenCalled();
});
