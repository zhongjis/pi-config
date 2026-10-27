import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boot, dir, required } from "./graph-run-registration.fixture.js";

const params = { subagent_type: "fixture", prompt: "work", description: "diagnostics fixture" };

function writeAgent(name: string, fields: string): string {
  const path = join(dir, ".pi", "agents", `${name}.md`);
  writeFileSync(path, `---\n${fields}\n---\nTask`);
  return realpathSync(path);
}

describe("user-only delegation diagnostics", () => {
  it("warns once across startup and agent-tool reloads for each empty positive policy", async () => {
    writeAgent("unknown", "delegation: +nosuch");
    writeAgent("subtracted", "delegation: +fixture, -fixture");
    writeAgent("writer", "tools: +write");
    writeAgent("unsafe", "delegation: +writer");
    writeAgent("leaf", "tools: +read");
    writeAgent("valid", "delegation: +nosuch, +leaf");
    writeAgent("disabled", "enabled: false\ndelegation: +nosuch");
    const minusPath = writeAgent("minus", "delegation: -leaf");
    const host = boot();

    await host.lifecycle("session_start");
    const agent = required(host.tools.get("agent"));
    const first = await agent.execute("first", params, undefined, undefined, host.ctx);
    await agent.execute("second", params, undefined, undefined, host.ctx);

    expect(host.ui.notify.mock.calls).toEqual([
      [expect.stringContaining(`Agent minus (${minusPath}) delegation:`), "warning"],
      ["Agent subtracted delegation: no valid read-only targets; nesting disabled.", "warning"],
      ["Agent unknown delegation: no valid read-only targets; nesting disabled.", "warning"],
      ["Agent unsafe delegation: no valid read-only targets; nesting disabled.", "warning"],
    ]);
    expect(first.content.some((part) => part.text?.includes("nesting disabled"))).toBe(false);
    expect(host.api.sendMessage).not.toHaveBeenCalled();
  });

  it("surfaces invalid-file diagnostics found at startup and on a later reload only once", async () => {
    const brokenPath = writeAgent("broken", "skills: research");
    const host = boot();
    await host.lifecycle("session_start");
    const laterPath = writeAgent("later", "delegation: +@builtin");
    const agent = required(host.tools.get("agent"));

    const result = await agent.execute("first", params, undefined, undefined, host.ctx);
    await agent.execute("second", params, undefined, undefined, host.ctx);

    expect(host.ui.notify.mock.calls).toEqual([
      [expect.stringContaining(`Agent broken (${brokenPath}) skills:`), "error"],
      ["Agent broken: no valid definition; agent unavailable", "warning"],
      [expect.stringContaining(`Agent later (${laterPath}) delegation:`), "error"],
      ["Agent later: no valid definition; agent unavailable", "warning"],
    ]);
    expect(result.content.some((part) => part.text?.includes(brokenPath) || part.text?.includes(laterPath))).toBe(false);
    expect(host.api.sendMessage).not.toHaveBeenCalled();
  });

  it("shows a fallback warning once without adding duplicate diagnostic prefixes", async () => {
    const directory = join(dir, ".pi", "agents", "fixture");
    mkdirSync(directory);
    writeFileSync(join(directory, "default.md"), "---\ntools: read\n---\nINVALID_BODY");
    const host = boot();
    await host.lifecycle("session_start");
    const agent = required(host.tools.get("agent"));

    const result = await agent.execute("first", params, undefined, undefined, host.ctx);
    await agent.execute("second", params, undefined, undefined, host.ctx);

    expect(host.ui.notify.mock.calls).toEqual([
      [expect.stringContaining(`Agent fixture (${realpathSync(join(directory, "default.md"))}) tools:`), "error"],
      [`Agent fixture (${realpathSync(join(directory, "default.md"))}): invalid definition; using ${realpathSync(join(dir, ".pi", "agents", "fixture.md"))}`, "warning"],
    ]);
    expect(result.content.some(part => part.text?.includes("invalid definition"))).toBe(false);
  });

  it("exposes live signed-rule resolution over enabled registry entries through the bridge", async () => {
    writeAgent("leaf", "tools: +read");
    writeAgent("disabled", "enabled: false");
    const host = boot();
    await host.lifecycle("session_start");
    const bridge: unknown = Reflect.get(globalThis, Symbol.for("pi-subagents:manager"));
    if (typeof bridge !== "object" || bridge === null || !("resolveDelegationTargets" in bridge) || typeof bridge.resolveDelegationTargets !== "function") {
      throw new Error("Delegation resolver was not published");
    }

    expect(bridge.resolveDelegationTargets([
      { sign: "+", selector: "@all" }, { sign: "-", selector: "fixture" }, { sign: "+", selector: "nosuch" },
    ])).toEqual(["leaf"]);
    writeAgent("leaf", "enabled: false");
    await required(host.tools.get("agent")).execute("reload", params, undefined, undefined, host.ctx);
    expect(bridge.resolveDelegationTargets([{ sign: "+", selector: "leaf" }])).toEqual([]);
  });
});
