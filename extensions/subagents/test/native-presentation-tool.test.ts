import { describe, expect, it, vi } from "vitest";
import { projectNativeResult } from "../src/native-presentation.js";
import type { AgentDetails } from "../src/ui/agent-format.js";
import { required } from "./graph-run-registration.fixture.js";
import { launchParams, presentationHost } from "./native-presentation.fixture.js";

const details: AgentDetails = {
  displayName: "Specialist", description: "Bounded task", subagentType: "fixture", agentId: "child-1",
  modelName: "provider/actual", toolUses: 3, tokens: "", durationMs: 2000, status: "running",
  activity: "reading files", result: "Latest response",
};

describe("deferred presentation tool", () => {
  it("returns an error immediately with no live channel, including after a completed call", async () => {
    const host = presentationHost();
    const presentation = required(host.tools.get("subagent"));
    expect(presentation.exposure).toBe("deferred");
    await required(host.tools.get("agent")).execute("run", launchParams, undefined, undefined, host.context("run"));
    // The channel closes once its nested call settles, which may trail the run.
    for (const id of ["unowned", "run/1"]) {
      await vi.waitFor(async () => expect(await presentation.execute(id, {}, undefined, undefined, host.ctx)).toMatchObject({ isError: true }));
    }
  });
});

describe("T3 entry projection", () => {
  it("puts activity before response and uses bounded task, display name and actual model", () => {
    expect(projectNativeResult(details)).toEqual({
      agent: "Specialist", task: "Bounded task", model: "provider/actual", step: 0, finished: false,
      messages: [{ role: "assistant", content: [{ type: "text", text: "reading files\nLatest response" }] }],
    });
  });

  it.each(["completed", "force_steered"] as const)("projects %s as successful completion", status => {
    expect(projectNativeResult({ ...details, status }, { finished: true })).toMatchObject({
      finished: true, exitCode: 0, messages: [{ content: [{ text: "Latest response" }] }],
    });
  });

  it.each(["stopped", "aborted"] as const)("projects %s as interruption with an assistant reason", status => {
    expect(projectNativeResult({ ...details, status, error: "interrupted by owner" }, { finished: true })).toMatchObject({
      finished: true, stopReason: "aborted", errorMessage: "interrupted by owner", messages: [{ content: [{ text: "interrupted by owner" }] }],
    });
  });

  it("bounds only projected text, retaining the complete original result", () => {
    const full = { ...details, status: "completed" as const, result: "x".repeat(15_000) };
    const projected = projectNativeResult(full, { finished: true });
    expect(projected.messages[0]?.content[0]?.text).toHaveLength(10_000);
    expect(full.result).toHaveLength(15_000);
  });
});
