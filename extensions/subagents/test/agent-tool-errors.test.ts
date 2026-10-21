import { describe, expect, it } from "vitest";
import { boot, mockSessions, required } from "./graph-run-registration.fixture.js";

const params = { subagent_type: "fixture", prompt: "work", description: "error fixture" };

describe("agent tool failures", () => {
  it.each([false, true])("marks a refused spawn as an error (background: %s)", async (background) => {
    const host = boot();
    await host.lifecycle("session_start");
    await host.lifecycle("session_shutdown");

    const result = await required(host.tools.get("agent")).execute("spawn", {
      ...params, run_in_background: background,
    }, undefined, undefined, host.ctx);

    expect(result).toMatchObject({ isError: true, content: [{ text: "Agent manager is disposed" }] });
  });

  it.each([false, true])("marks execution failure as an error (resume: %s)", async (resume) => {
    const host = boot();
    await host.lifecycle("session_start");
    const agent = required(host.tools.get("agent"));
    let fail = false;
    mockSessions(() => {
      if (fail) throw new Error("provider execution failed");
      return "first";
    });
    const launched = resume ? await agent.execute("first", params, undefined, undefined, host.ctx) : undefined;
    const id = launched && required(/Agent ID: (\S+)/.exec(launched.content[0]?.text ?? "")?.[1]);
    fail = true;

    const result = await agent.execute("failed", { ...params, ...(id ? { resume: id } : {}) }, undefined, undefined, host.ctx);

    expect(result).toMatchObject({ isError: true, details: { status: "error", error: "provider execution failed" } });
  });

  it("keeps an agent-reported negative outcome as successful result data", async () => {
    const host = boot();
    await host.lifecycle("session_start");
    mockSessions(() => "Agent failed: the proposed approach is infeasible");

    const result = await required(host.tools.get("agent")).execute("outcome", params, undefined, undefined, host.ctx);

    expect(result).toMatchObject({ details: { status: "completed", result: "Agent failed: the proposed approach is infeasible" } });
    expect(result).not.toHaveProperty("isError", true);
  });
});
