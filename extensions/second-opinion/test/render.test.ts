import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEventListeners } from "node:events";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import secondOpinion from "../index.js";

vi.mock("@earendil-works/pi-tui", async () =>
  import("../../../node_modules/@earendil-works/pi-tui/dist/index.js")
);

type RenderableText = { render?: (width: number) => string[]; text?: string };
type PlainTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string };
type ToolResult = { content?: readonly { type: "text"; text: string }[]; details?: unknown; isError?: boolean };
type ExecResult = { code: number; stdout: string; stderr: string };
type TestContext = { cwd: string; mode: "rpc"; ui: { notify: () => void; select: () => Promise<string> } };
type ToolDefinition = {
  name: string;
  execute: (id: string, params: unknown, signal: AbortSignal, onUpdate: undefined, ctx: TestContext) => Promise<ToolResult>;
  renderCall?: (args: Record<string, unknown>, theme: PlainTheme, context?: unknown) => RenderableText;
  renderResult?: (
    result: ToolResult,
    options: { expanded?: boolean; isPartial?: boolean },
    theme: PlainTheme,
    context?: { args?: Record<string, unknown>; isError?: boolean },
  ) => RenderableText;
};

type MockPi = {
  registerTool: (tool: ToolDefinition) => void;
  registerCommand: (name: string, command: unknown) => void;
  registerFlag: (flag: unknown) => void;
  on: (event: string, handler: unknown) => void;
  sendMessage: () => void;
  sendUserMessage: () => never;
  exec: (command: string, args: string[]) => Promise<ExecResult>;
  events: { emit: () => void };
  getActiveTools: () => never;
  setActiveTools: () => never;
};

const plainTheme: PlainTheme = {
  fg: vi.fn((_color: string, text: string) => text),
  bold: vi.fn((text: string) => text),
};

const args = Object.freeze({
  reason: "agent selected implementation files",
  repos: Object.freeze([
    Object.freeze({ path: "/repo/a", include: Object.freeze(["src/a.ts"]), exclude: Object.freeze(["pnpm-lock.yaml"]) }),
    Object.freeze({ path: "/repo/b", include: Object.freeze(["src/b.ts"]) }),
  ]),
});

function renderText(component: RenderableText, width = 120): string {
  if (typeof component.render === "function") return component.render(width).join("\n");
  return component.text ?? "";
}

function expectWidthSafe(component: RenderableText): void {
  expect(component.render).toBeTypeOf("function");
  for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
    for (const line of component.render!(width)) {
      expect(visibleWidth(line), `${JSON.stringify(line)} at width ${width}`).toBeLessThanOrEqual(width);
    }
  }
}

function registerScopeTool(overrides: Partial<MockPi> = {}): ToolDefinition {
  let registered: ToolDefinition | undefined;
  const pi: MockPi = {
    registerTool(tool) {
      registered = tool;
    },
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    on: vi.fn(),
    sendMessage: () => { throw new Error("renderer must not send messages"); },
    sendUserMessage: () => { throw new Error("renderer must not send user messages"); },
    exec: () => { throw new Error("renderer must not exec"); },
    events: { emit: () => { throw new Error("renderer must not emit events"); } },
    getActiveTools: () => { throw new Error("renderer must not read active tools"); },
    setActiveTools: () => { throw new Error("renderer must not set active tools"); },
    ...overrides,
  };
  secondOpinion(pi as never);
  expect(registered).toBeDefined();
  if (!registered) throw new Error("scope tool was not registered");
  return registered;
}

function textResult(text: string): ToolResult {
  return Object.freeze({ content: Object.freeze([Object.freeze({ type: "text" as const, text })]) });
}

describe("codex_review_session_scope rendering", () => {
  it("renders repo count and reason in calls without side effects", () => {
    const tool = registerScopeTool();
    const call = tool.renderCall!(args, plainTheme);

    expect(renderText(call)).toContain("▸ codex_review_session_scope · 2 repos · reason: agent selected implementation files");
    expectWidthSafe(call);
  });

  it("distinguishes plan-listed outcomes and preserves frozen raw expansion", () => {
    const tool = registerScopeTool();
    const complete = textResult("Codex scoped review complete and posted. Address-comments follow-up sent.");
    const noFollowup = textResult("Codex scoped review complete and posted.");
    const failed = textResult("Codex review failed: /repo/a: Could not determine a base ref");
    const invalid = textResult("Repo scope needs at least one included path: /repo/a");

    expect(renderText(tool.renderResult!(complete, { expanded: false }, plainTheme, { args }))).toContain("next: address-comments follow-up sent");
    expect(renderText(tool.renderResult!(noFollowup, { expanded: false }, plainTheme, { args }))).toContain("next: no follow-up requested");
    expect(renderText(tool.renderResult!(failed, { expanded: false }, plainTheme, { args }))).toContain("status: failed");
    expect(renderText(tool.renderResult!(invalid, { expanded: false }, plainTheme, { args }))).toContain("status: blocked · invalid scope");

    const expanded = tool.renderResult!(complete, { expanded: true }, plainTheme, { args });
    expect(expanded.text).toBe("Codex scoped review complete and posted. Address-comments follow-up sent.");
    expect(complete.content![0].text).toBe("Codex scoped review complete and posted. Address-comments follow-up sent.");
    expectWidthSafe(tool.renderResult!(complete, { expanded: false }, plainTheme, { args }));
  });
});

describe("codex_review_session_scope execution", () => {
  let directory: string;
  const controller = () => new AbortController();
  const ctx: TestContext = { cwd: process.cwd(), mode: "rpc", ui: { notify() {}, select: async () => "No" } };
  const scope = { reason: "implementation", repos: [{ path: process.cwd(), include: ["src/a.ts"] }] };
  const exec: MockPi["exec"] = async (command, argv) => ({
    code: 0,
    stdout: command === "codex" ? "Logged in" : argv[0] === "status" ? " M src/a.ts" : argv[0] === "rev-parse" ? "main" : "",
    stderr: "",
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "second-opinion-"));
    vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
    await writeFile(join(directory, "codex"), `#!${process.execPath}\nprocess.stdout.write("review complete");\n`, { mode: 0o700 });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("marks invalid scope as an error with explicit details", async () => {
    const result = await registerScopeTool().execute("scope", { repos: [] }, controller().signal, undefined, ctx);
    expect(result).toMatchObject({ isError: true, details: undefined });
    expect(result.content?.[0].text).toBe("At least one repo scope is required.");
  });

  it("marks review failure as an error with the renderer prefix", async () => {
    await writeFile(join(directory, "codex"), `#!${process.execPath}\nprocess.stderr.write("review unavailable"); process.exit(1);\n`);
    const result = await registerScopeTool({ exec }).execute("scope", scope, controller().signal, undefined, ctx);
    expect(result).toMatchObject({ isError: true, details: undefined });
    expect(result.content?.[0].text).toMatch(/^Codex review failed: .*review unavailable/);
  });

  it("marks caught exceptions as errors without changing their text", async () => {
    const tool = registerScopeTool({ exec, sendMessage() { throw new Error("posting failed"); } });
    const result = await tool.execute("scope", scope, controller().signal, undefined, ctx);
    expect(result).toMatchObject({ isError: true, details: undefined });
    expect(result.content?.[0].text).toBe("posting failed");
  });

  it("returns explicit details on success and removes its abort listener", async () => {
    const abort = controller();
    const result = await registerScopeTool({ exec, sendMessage() {}, events: { emit() {} } }).execute("scope", scope, abort.signal, undefined, ctx);
    expect(result).toHaveProperty("details", undefined);
    expect(result.isError).not.toBe(true);
    expect(result.content?.[0].text).toBe("Codex scoped review complete and posted.");
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });

  it("kills the child and settles promptly when the tool is aborted", async () => {
    const ready = join(directory, "ready");
    const killed = join(directory, "killed");
    await writeFile(join(directory, "codex"), `#!${process.execPath}
const fs = require("node:fs");
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(killed)}, "SIGTERM"); process.exit(0); });
fs.writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1000);
`);
    const abort = controller();
    const posted = vi.fn();
    const pending = registerScopeTool({ exec, sendMessage: posted }).execute("scope", scope, abort.signal, undefined, ctx);
    try {
      await vi.waitFor(async () => expect(await readFile(ready, "utf8")).toBe("ready"));
      abort.abort();
      await expect(pending).resolves.toMatchObject({ isError: true, details: undefined });
      await vi.waitFor(async () => expect(await readFile(killed, "utf8")).toBe("SIGTERM"));
      expect(posted).not.toHaveBeenCalled();
      expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    } finally {
      abort.abort();
      await pending;
    }
  });

  it("does not spawn a review when the tool signal is already aborted", async () => {
    await writeFile(join(directory, "codex"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(join(directory, "spawned"))}, "spawned");\n`);
    const abort = controller();
    abort.abort();
    const result = await registerScopeTool({ exec }).execute("scope", scope, abort.signal, undefined, ctx);
    expect(result.isError).toBe(true);
    await expect(readFile(join(directory, "spawned"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
