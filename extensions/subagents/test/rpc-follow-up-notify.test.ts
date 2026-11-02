import { describe, expect, it } from "vitest";
import { boot } from "./graph-run-registration.fixture.js";

const followUp = {
  type: "message_start",
  message: {
    role: "custom", customType: "subagent-notification", display: true, content: "done",
    details: { id: "a1", description: "scan repo", status: "completed", others: [{ id: "a2", description: "read docs", status: "error" }] },
  },
};

describe("Subagent follow-ups outside the terminal", () => {
  it("name the reported Subagents through notify when they enter the turn", async () => {
    const host = boot();
    Object.assign(host.ctx, { mode: "rpc", hasUI: true });
    await host.lifecycle("message_start", followUp);
    expect(host.ui.notify).toHaveBeenCalledExactlyOnceWith("Subagent update: scan repo (completed), read docs (error)", "info");
  });

  it("stay silent in the terminal, which renders the message itself", async () => {
    const host = boot();
    Object.assign(host.ctx, { hasUI: true });
    await host.lifecycle("message_start", followUp);
    expect(host.ui.notify).not.toHaveBeenCalled();
  });
});
