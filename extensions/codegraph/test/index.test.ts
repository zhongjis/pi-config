import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  spawn: spawnMock,
}));
vi.mock("@earendil-works/pi-tui", async () =>
  import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"),
);

type RenderableText = { render?: (width: number) => string[]; text?: string };
type PlainTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string };

type ToolDefinition = {
  name: string;
  renderCall?: (args: Record<string, unknown>, theme: PlainTheme, context?: unknown) => RenderableText;
  renderResult?: (
    result: { content?: readonly unknown[]; details?: unknown; isError?: boolean },
    options: { expanded?: boolean; isPartial?: boolean },
    theme: PlainTheme,
    context?: { args?: Record<string, unknown>; isError?: boolean },
  ) => RenderableText;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: { cwd: string },
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
};

type Handler = (event: { systemPrompt?: string }, ctx?: { cwd: string }) => Promise<{ systemPrompt?: string }>;

type MockPi = {
  tools: Map<string, ToolDefinition>;
  handlers: Map<string, Handler>;
  pi: {
    registerTool: (tool: ToolDefinition) => void;
    on: (event: string, handler: Handler) => void;
  };
};

class FakeStream extends EventEmitter {
  write = vi.fn();
}

type FakeChild = EventEmitter & {
  kind: "serve" | "init";
  stdout: FakeStream;
  stderr: FakeStream;
  stdin: FakeStream;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  writes: Array<Record<string, unknown>>;
};

function createMockPi(): MockPi {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler>();
  return {
    tools,
    handlers,
    pi: {
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
    },
  };
}

type CreateChildOptions = {
  kind?: "serve" | "init";
  errorOnInitialize?: Error;
  exitCode?: number;
  resultText?: string;
  toolError?: boolean;
  toolResponseDelay?: Promise<void>;
  initExitDelay?: Promise<void>;
  initStdout?: string;
  initStderr?: string;
};

function createChild(options: CreateChildOptions = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new FakeStream();
  child.stderr = new FakeStream();
  child.stdin = new FakeStream();
  child.killed = false;
  child.writes = [];
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  child.kind = options.kind ?? "serve";
  if (child.kind === "init") {
    queueMicrotask(async () => {
      await options.initExitDelay;
      if (options.initStdout) child.stdout.emit("data", options.initStdout);
      if (options.initStderr) child.stderr.emit("data", options.initStderr);
      child.emit("exit", options.exitCode ?? 0, null);
      child.emit("close", options.exitCode ?? 0, null);
    });
  }
  child.stdin.write.mockImplementation((payload: string) => {
    const msg = JSON.parse(payload.trim()) as Record<string, unknown>;
    child.writes.push(msg);
    if (msg.method === "initialize") {
      queueMicrotask(() => {
        if (options.errorOnInitialize) {
          child.emit("error", options.errorOnInitialize);
          return;
        }
        child.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n`);
      });
    }
    if (msg.method === "tools/call") {
      queueMicrotask(async () => {
        await options.toolResponseDelay;
        child.stdout.emit(
          "data",
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: options.toolError
              ? { isError: true, content: [{ type: "text", text: options.resultText ?? "tool failed" }] }
              : { content: [{ type: "text", text: options.resultText ?? "ok" }] },
          })}\n`,
        );
      });
    }
    return true;
  });
  return child;
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function getToolCall(child: FakeChild): { params: { name: string; arguments: Record<string, unknown> } } {
  const toolCall = child.writes.find((msg) => msg.method === "tools/call") as
    | { params: { name: string; arguments: Record<string, unknown> } }
    | undefined;
  expect(toolCall).toBeDefined();
  return toolCall!;
}

function getSpawnSubcommands(): string[] {
  return spawnMock.mock.calls.map(([, args]) => (args as string[])[0]);
}

const plainTheme = {
  fg: vi.fn((_color: string, text: string) => text),
  bold: vi.fn((text: string) => text),
};

function renderText(component: RenderableText, width = 120): string {
  if (typeof component.render === "function") return component.render(width).join("\n");
  return component.text ?? "";
}

function expectWidthSafe(component: RenderableText): void {
  expect(component.render).toBeTypeOf("function");
  for (const width of [20, 40, 80, 120]) {
    for (const line of component.render!(width)) {
      expect(visibleWidth(line), `${JSON.stringify(line)} at width ${width}`).toBeLessThanOrEqual(width);
    }
  }
}

async function createInvalidGlobalCodeGraph(root: string): Promise<void> {
  const marker = path.join(root, ".codegraph");
  await mkdir(path.join(marker, "daemons"), { recursive: true });
  await writeFile(path.join(marker, "telemetry.json"), "{}\n");
}

async function loadExtension() {
  const module = await import("../index.js");
  return module;
}

const ExpectedBeforeAgentStartGuidance = [
  "For architecture, flow, where-is-symbol, impact, and codebase navigation questions, use CodeGraph (codegraph_* tools) directly before grep/read.",
  "First non-status CodeGraph query may initialize a cold worktree automatically if needed.",
  "Use codegraph_explore first for broad questions, codegraph_search for symbol-name lookup, codegraph_files for project structure, codegraph_node for a known symbol, and codegraph_callers/codegraph_impact for impact and flow analysis.",
  "If codegraph_search returns no exact result, try codegraph_explore or codegraph_files/codegraph_node before falling back to grep/read; symbol search may miss literal constants or generated names that still exist in source text.",
  "Do not re-verify a CodeGraph result with grep/read, and do not re-open files whose source codegraph_explore or codegraph_node already returned.",
  "Do not loop codegraph_node over many symbols — use codegraph_impact or codegraph_callers for breadth, and codegraph_explore to read several at once.",
  "Otherwise use grep/read only after CodeGraph is insufficient or when the user asks for literal text matching.",
].join("\n");

describe("codegraph extension", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "pi-codegraph-"));
    spawnMock.mockReset();
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("registers all CodeGraph tools", async () => {
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();

    codegraphExtension(mock.pi as never);

    expect([...mock.tools.keys()]).toEqual([
      "codegraph_search",
      "codegraph_callers",
      "codegraph_callees",
      "codegraph_impact",
      "codegraph_explore",
      "codegraph_node",
      "codegraph_status",
      "codegraph_files",
    ]);
  });

  it("renders all eight names with decisive inputs and explicit project targets", async () => {
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);
    const cases = [
      ["codegraph_search", { query: "按钮", projectPath: "/repo" }, "query: 按钮"],
      ["codegraph_callers", { symbol: "render\u001b[31mCall\u001b[0m", projectPath: "/repo" }, "symbol: render"],
      ["codegraph_callees", { symbol: "renderCall", projectPath: "/repo" }, "symbol: renderCall"],
      ["codegraph_impact", { symbol: "renderCall", projectPath: "/repo" }, "symbol: renderCall"],
      ["codegraph_explore", { query: "renderer flow", projectPath: "/repo" }, "query: renderer flow"],
      ["codegraph_node", { symbol: "renderCall", projectPath: "/repo" }, "symbol: renderCall"],
      ["codegraph_status", { projectPath: "/repo" }, "op: inspect index"],
      ["codegraph_files", { path: "src/界面", projectPath: "/repo" }, "path: src/界面"],
    ] as const;

    for (const [name, args, decisive] of cases) {
      const component = mock.tools.get(name)!.renderCall!(args, plainTheme);
      const text = renderText(component);
      expect(text).toContain(`▸ ${name}`);
      expect(text).toContain(decisive);
      expect(text).toContain("project: /repo");
      expectWidthSafe(component);
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("summarizes known outputs with state, counts, and highlights", async () => {
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);
    const render = (toolName: string, text: string, args: Record<string, unknown> = {}) =>
      renderText(mock.tools.get(toolName)!.renderResult!(
        { content: [{ type: "text" as const, text }] },
        { expanded: false, isPartial: false },
        plainTheme,
        { args },
      ));

    expect(render("codegraph_status", [
      "**CodeGraph Status**",
      "**Files indexed:** 339",
      "**Total nodes:** 4471",
      "**Database size:** 15.63 MB",
      "**Backend:** node:sqlite (Node built-in) — full WAL + FTS5",
      "**Languages:**",
      "- typescript: 333",
      "- yaml: 2",
    ].join("\n"))).toContain("index: 339 files · 4471 nodes · 15.63 MB");
    expect(render("codegraph_files", "**Project Structure (2 files)**", { path: "extensions/codegraph", format: "tree" }))
      .toContain("structure: 2 files");
    expect(render("codegraph_search", "**Search Results (1 found)**\n\n**renderCodeGraphResult** (function)"))
      .toContain("top: renderCodeGraphResult (function)");
    expect(render("codegraph_node", "**Location:** extensions/codegraph/index.ts:818\n**Calls →** a, b, +3 more\n**Called by ←** c"))
      .toContain("calls: 5");
    expect(render("codegraph_callers", "**Callers of renderCodeGraphResult (1 found)**\n\n- codegraphExtension (function) - extensions/codegraph/index.ts:997"))
      .toContain("callers: 1 found");
    expect(render("codegraph_callees", "**Callees of renderCodeGraphResult (8 found)**\n\n- getResultText (function)\n- countResultLines (function)"))
      .toContain("callees: 8 found");
    expect(render("codegraph_impact", "**Impact: \"renderCodeGraphResult\" affects 2 symbols**\n\n**extensions/codegraph/index.ts:**"))
      .toContain("impact: 2 symbols");
    expect(render("codegraph_explore", "Found 35 symbols across 2 files.\n\n**Blast radius — what depends on these**\n\n- renderCodeGraphResult\n- render\n\n**Source Code**"))
      .toContain("found: 35 symbols · 2 files");
    expect(render("codegraph_explore", "Found 35 symbols across 2 files.\n\n**Source Code**"))
      .toContain("status: complete");
  });

  it("preserves frozen raw output in expansion and safely falls back for malformed output", async () => {
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);
    const tool = mock.tools.get("codegraph_explore")!;
    const raw = "\u001b[32m分析完成\u001b[0m\n\n```ts\nconst value = 'raw';\n```";
    const content = Object.freeze([{ type: "text" as const, text: raw }]);
    const result = Object.freeze({ content, details: Object.freeze({ broken: true }) });

    const expanded = tool.renderResult!(result, { expanded: true }, plainTheme, {
      args: { query: "renderer", projectPath: "/repo" },
    });
    expect(expanded.text).toBe(raw);
    expect(result.content[0].text).toBe(raw);
    expectWidthSafe(expanded);

    const malformed = tool.renderResult!(
      { content: [{ type: "text", text: "unexpected owner output\nopaque detail" }], details: { broken: true } },
      { expanded: false },
      plainTheme,
      { args: { query: "renderer" } },
    );
    expect(renderText(malformed)).toContain("result: unexpected owner output");
    expectWidthSafe(malformed);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("renders operation-specific partial activity and decisive errors", async () => {
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const indexing = renderText(mock.tools.get("codegraph_status")!.renderResult!(
      { content: [] },
      { expanded: false, isPartial: true },
      plainTheme,
      { args: { projectPath: "/repo" } },
    ));
    expect(indexing).toContain("status: running · indexing");

    const analysis = renderText(mock.tools.get("codegraph_impact")!.renderResult!(
      { content: [] },
      { expanded: false, isPartial: true },
      plainTheme,
      { args: { symbol: "renderCall" } },
    ));
    expect(analysis).toContain("status: running · impact analysis");

    const error = renderText(mock.tools.get("codegraph_search")!.renderResult!(
      { content: [{ type: "text", text: "CodeGraph failed decisively\nstack hidden" }], isError: true },
      { expanded: false },
      plainTheme,
      { args: { query: "renderer" }, isError: true },
    ));
    expect(error).toContain("error: CodeGraph failed decisively");
    expect(error).not.toContain("stack hidden");
    expect(error).toContain("app.tools.expand to expand full result");
  });

  it("keeps ANSI/CJK renderer output safe at 20/40/80/120 columns", async () => {
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);
    const tool = mock.tools.get("codegraph_search")!;
    const call = tool.renderCall!(
      { query: "\u001b[36m超长查询界面组件\u001b[0m", projectPath: "/非常/长/项目/路径" },
      plainTheme,
    );
    const result = tool.renderResult!(
      { content: [{ type: "text", text: "**Search Results (2 found)**\n\n**界面组件一** (function)\n**界面组件二** (class)" }] },
      { expanded: false },
      plainTheme,
      { args: { query: "界面组件" } },
    );
    expectWidthSafe(call);
    expectWidthSafe(result);
  });

  it("injects concise before_agent_start guidance for a bare .codegraph marker without spawning CodeGraph", async () => {
    await mkdir(path.join(tempRoot, ".codegraph"));
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();

    codegraphExtension(mock.pi as never);
    const handler = mock.handlers.get("before_agent_start");
    expect(handler).toBeDefined();
    const result = await handler!({ systemPrompt: "base" }, { cwd: tempRoot });
    const promptLines = result.systemPrompt!.slice("base\n\n".length).split("\n");

    expect(result.systemPrompt).toBe(`base\n\n${ExpectedBeforeAgentStartGuidance}`);
    expect(promptLines).toEqual(ExpectedBeforeAgentStartGuidance.split("\n"));
    expect(promptLines).toHaveLength(7);
    expect(promptLines.filter((line) => line.includes("cold worktree"))).toHaveLength(1);
    expect(result.systemPrompt).not.toContain("codegraph init");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("skips before_agent_start guidance when the project has no .codegraph marker", async () => {
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();

    codegraphExtension(mock.pi as never);
    const handler = mock.handlers.get("before_agent_start");
    expect(handler).toBeDefined();
    const result = await handler!({ systemPrompt: "base" }, { cwd: tempRoot });

    expect(result.systemPrompt).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("uses ctx.cwd as default projectPath for ready codegraph_status", async () => {
    await mkdir(path.join(tempRoot, ".codegraph"));
    const child = createChild({ resultText: "status ok" });
    spawnMock.mockReturnValue(child);
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const result = await mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: tempRoot });

    expect(result.content[0].text).toBe("status ok");
    expect(spawnMock).toHaveBeenCalledWith("codegraph", ["serve", "--mcp", "--path", tempRoot], {
      cwd: tempRoot,
      env: expect.objectContaining({ CODEGRAPH_PARSE_WORKERS: "1" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(child.kill).toHaveBeenCalled();
  });

  it("returns no-marker codegraph_status without spawning or init guidance", async () => {
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const result = await mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: tempRoot });
    const text = result.content[0].text;

    expect(text).toContain(`CodeGraph is not enabled for ${tempRoot}.`);
    expect(text).toContain("No .codegraph marker was found");
    expect(text).toContain("did not create or initialize an index");
    expect(text).not.toContain("codegraph init");
    expect(existsSync(path.join(tempRoot, ".codegraph"))).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("lets explicit projectPath override ctx.cwd", async () => {
    const projectPath = await mkdtemp(path.join(tempRoot, "override-"));
    await mkdir(path.join(projectPath, ".codegraph"));
    spawnMock.mockReturnValue(createChild());
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    await mock.tools.get("codegraph_status")!.execute(
      "tool-1",
      { projectPath },
      undefined,
      undefined,
      { cwd: tempRoot },
    );

    expect(spawnMock).toHaveBeenCalledWith("codegraph", ["serve", "--mcp", "--path", projectPath], expect.objectContaining({ cwd: projectPath }));
  });

  it("rejects invalid projectPath values", async () => {
    const filePath = path.join(tempRoot, "file.ts");
    await writeFile(filePath, "export {};\n");
    const { resolveProjectCwd } = await loadExtension();

    await expect(resolveProjectCwd("relative/path")).rejects.toThrow("CodeGraph projectPath must be an absolute path.");
    await expect(resolveProjectCwd(path.join(tempRoot, "missing"))).rejects.toThrow(
      "CodeGraph projectPath does not exist or is not accessible.",
    );
    await expect(resolveProjectCwd(filePath)).rejects.toThrow("CodeGraph projectPath must point to a directory.");
  });

  it("shares codegraph init by canonical root and spawns codegraph init <root>", async () => {
    const projectRoot = await mkdtemp(path.join(tempRoot, "mono-"));
    await mkdir(path.join(projectRoot, ".codegraph"));
    const nested = path.join(projectRoot, "packages", "app");
    await mkdir(nested, { recursive: true });
    let releaseInit!: () => void;
    const initExitDelay = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    const child = createChild({ kind: "init", initExitDelay });
    spawnMock.mockReturnValue(child);
    const { initCodeGraphProject } = await loadExtension();

    const first = initCodeGraphProject(nested);
    const second = initCodeGraphProject(projectRoot);
    await waitFor(() => spawnMock.mock.calls.length === 1);

    expect(spawnMock).toHaveBeenCalledWith("codegraph", ["init", projectRoot], {
      cwd: projectRoot,
      env: expect.objectContaining({ CODEGRAPH_PARSE_WORKERS: "1" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    releaseInit();
    await Promise.all([first, second]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("clears failed init promises and reports sanitized bounded diagnostics", async () => {
    spawnMock
      .mockImplementationOnce(() => createChild({
        kind: "init",
        exitCode: 1,
        initStdout: `stdout ${"x".repeat(1200)}`,
        initStderr: `\u001b[31mAPI_KEY=secret Bearer abcdef --password hunter2 ${"y".repeat(1200)}`,
      }))
      .mockImplementationOnce(() => createChild({ kind: "init" }));
    const { initCodeGraphProject } = await loadExtension();

    const message = await initCodeGraphProject(tempRoot).then(
      () => "",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    );

    expect(message).toContain("exited with code 1");
    expect(message).toContain("stderr:");
    expect(message).toContain("stdout:");
    expect(message).toContain("API_KEY=[redacted]");
    expect(message).toContain("Bearer [redacted]");
    expect(message).toContain("--[redacted]");
    expect(message).not.toContain("\u001b[31m");
    expect(message.length).toBeLessThan(2300);
    await initCodeGraphProject(tempRoot);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("uses CODEGRAPH_INIT_TIMEOUT_MS independently, kills timed-out init, and clears the promise", async () => {
    process.env.CODEGRAPH_TIMEOUT_MS = "1";
    process.env.CODEGRAPH_INIT_TIMEOUT_MS = "20";
    try {
      const timedOutChild = createChild({ kind: "init", initExitDelay: new Promise<void>(() => { /* never settles */ }) });
      spawnMock
        .mockImplementationOnce(() => timedOutChild)
        .mockImplementationOnce(() => createChild({ kind: "init" }));
      const { initCodeGraphProject } = await loadExtension();

      await expect(initCodeGraphProject(tempRoot)).rejects.toThrow("timed out after 20ms");
      expect(timedOutChild.kill).toHaveBeenCalled();
      await initCodeGraphProject(tempRoot);
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.CODEGRAPH_TIMEOUT_MS;
      delete process.env.CODEGRAPH_INIT_TIMEOUT_MS;
    }
  });

  it("kills init on abort and clears the aborted promise", async () => {
    const abortedChild = createChild({ kind: "init", initExitDelay: new Promise<void>(() => { /* never settles */ }) });
    spawnMock
      .mockImplementationOnce(() => abortedChild)
      .mockImplementationOnce(() => createChild({ kind: "init" }));
    const controller = new AbortController();
    const { initCodeGraphProject } = await loadExtension();

    const result = initCodeGraphProject(tempRoot, controller.signal);
    await waitFor(() => spawnMock.mock.calls.length === 1);
    controller.abort(new Error("user abort"));

    await expect(result).rejects.toThrow("user abort");
    expect(abortedChild.kill).toHaveBeenCalled();
    await initCodeGraphProject(tempRoot);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the CodeGraph CLI cannot spawn", async () => {
    await mkdir(path.join(tempRoot, ".codegraph"));
    const child = createChild({ errorOnInitialize: new Error("spawn codegraph ENOENT") });
    spawnMock.mockReturnValue(child);
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    await expect(
      mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: tempRoot }),
    ).rejects.toThrow("was not found on PATH");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalled();
  });

  it("normalizes absolute codegraph_files path inside ctx.cwd", async () => {
    await mkdir(path.join(tempRoot, ".codegraph"));
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);
    const absolutePath = path.join(tempRoot, "src", "index.ts");

    await mock.tools.get("codegraph_files")!.execute(
      "tool-1",
      { path: absolutePath },
      undefined,
      undefined,
      { cwd: tempRoot },
    );

    const toolCall = child.writes.find((msg) => msg.method === "tools/call") as { params: { arguments: { path: string } } };
    expect(toolCall.params.arguments.path).toBe("src/index.ts");
  });

  it("normalizes codegraph_files path and empty-result hint against marker root from nested cwd", async () => {
    const projectRoot = await mkdtemp(path.join(tempRoot, "mono-"));
    await mkdir(path.join(projectRoot, ".codegraph"));
    const nested = path.join(projectRoot, "packages", "app");
    await mkdir(nested, { recursive: true });
    const child = createChild({ resultText: "No files found matching the criteria." });
    spawnMock.mockReturnValue(child);
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);
    const absolutePath = path.join(projectRoot, "src", "index.ts");

    const result = await mock.tools.get("codegraph_files")!.execute(
      "tool-1",
      { path: absolutePath },
      undefined,
      undefined,
      { cwd: nested },
    );

    expect(getToolCall(child).params).toEqual({
      name: "codegraph_files",
      arguments: { projectPath: projectRoot, path: "src/index.ts" },
    });
    expect(result.content[0].text).toContain("No files found matching the criteria.");
    expect(result.content[0].text).toContain(`The filter "${absolutePath}" did not match any indexed path.`);
  });

  it("cleans up pending MCP session on tool error", async () => {
    await mkdir(path.join(tempRoot, ".codegraph"));
    const child = createChild({ resultText: "tool failed", toolError: true });
    spawnMock.mockReturnValue(child);
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    await expect(
      mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: tempRoot }),
    ).rejects.toThrow("tool failed");
    expect(child.kill).toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent calls for the same project", async () => {
    await mkdir(path.join(tempRoot, ".codegraph"));
    let releaseFirst!: () => void;
    const firstToolResponse = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let spawnCount = 0;
    spawnMock.mockImplementation(() => {
      spawnCount += 1;
      return createChild({
        resultText: `ok ${spawnCount}`,
        toolResponseDelay: spawnCount === 1 ? firstToolResponse : undefined,
      });
    });
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const first = mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: tempRoot });
    await waitFor(() => spawnMock.mock.calls.length === 1);
    const second = mock.tools.get("codegraph_files")!.execute("tool-2", {}, undefined, undefined, { cwd: tempRoot });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spawnMock).toHaveBeenCalledTimes(1);
    releaseFirst();
    const results = await Promise.all([first, second]);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.content[0].text)).toEqual(["ok 1", "ok 2"]);
  });

  it("continues same-project queue after a failed call", async () => {
    await mkdir(path.join(tempRoot, ".codegraph"));
    let spawnCount = 0;
    spawnMock.mockImplementation(() => {
      spawnCount += 1;
      return createChild({
        resultText: spawnCount === 1 ? "tool failed" : "ok after failure",
        toolError: spawnCount === 1,
      });
    });
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const first = mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: tempRoot });
    const second = mock.tools.get("codegraph_files")!.execute("tool-2", {}, undefined, undefined, { cwd: tempRoot });
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);

    expect(firstResult.status).toBe("rejected");
    expect(secondResult.status).toBe("fulfilled");
    if (secondResult.status === "fulfilled") {
      expect(secondResult.value.content[0].text).toBe("ok after failure");
    }
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("does not serialize calls for different projects", async () => {
    const projectPath = await mkdtemp(path.join(tempRoot, "other-"));
    await mkdir(path.join(tempRoot, ".codegraph"));
    await mkdir(path.join(projectPath, ".codegraph"));
    let releaseTools!: () => void;
    const toolResponse = new Promise<void>((resolve) => {
      releaseTools = resolve;
    });
    spawnMock.mockImplementation(() => createChild({ toolResponseDelay: toolResponse }));
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const first = mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: tempRoot });
    const second = mock.tools.get("codegraph_status")!.execute(
      "tool-2",
      { projectPath },
      undefined,
      undefined,
      { cwd: tempRoot },
    );
    await waitFor(() => spawnMock.mock.calls.length === 2);

    releaseTools();
    await Promise.all([first, second]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("resolves to the nearest ancestor that contains .codegraph", async () => {
    const projectRoot = await mkdtemp(path.join(tempRoot, "mono-"));
    await mkdir(path.join(projectRoot, ".codegraph"));
    const nested = path.join(projectRoot, "packages", "app");
    await mkdir(nested, { recursive: true });
    const { resolveProjectCwd } = await loadExtension();

    expect(await resolveProjectCwd(nested)).toBe(projectRoot);
    expect(await resolveProjectCwd(projectRoot)).toBe(projectRoot);
  });

  it("retries once after a tools/call timeout, then succeeds and kills the first child", async () => {
    await mkdir(path.join(tempRoot, ".codegraph"));
    process.env.CODEGRAPH_TIMEOUT_MS = "30";
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const firstChild = createChild({ toolResponseDelay: new Promise<void>(() => { /* never settles; forces a timeout */ }) });
      const secondChild = createChild({ resultText: "ok after retry" });
      spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
      const mock = createMockPi();
      const { default: codegraphExtension } = await loadExtension();
      codegraphExtension(mock.pi as never);

      const result = await mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: tempRoot });

      expect(result.content[0].text).toBe("ok after retry");
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(firstChild.kill).toHaveBeenCalled();
      expect(secondChild.kill).toHaveBeenCalled();
    } finally {
      delete process.env.CODEGRAPH_TIMEOUT_MS;
    }
  });

  it("fails after two tools/call timeouts and kills both subprocesses", async () => {
    await mkdir(path.join(tempRoot, ".codegraph"));
    process.env.CODEGRAPH_TIMEOUT_MS = "30";
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const firstChild = createChild({ toolResponseDelay: new Promise<void>(() => { /* never settles; forces a timeout */ }) });
      const secondChild = createChild({ toolResponseDelay: new Promise<void>(() => { /* never settles; forces a timeout */ }) });
      spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
      const mock = createMockPi();
      const { default: codegraphExtension } = await loadExtension();
      codegraphExtension(mock.pi as never);

      await expect(
        mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: tempRoot }),
      ).rejects.toThrow('CodeGraph MCP request "tools/call" timed out after 30ms. (after 2 attempts)');
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(firstChild.kill).toHaveBeenCalled();
      expect(secondChild.kill).toHaveBeenCalled();
    } finally {
      delete process.env.CODEGRAPH_TIMEOUT_MS;
    }
  });

  it("does not retry when aborted during tools/call timeout backoff", async () => {
    await mkdir(path.join(tempRoot, ".codegraph"));
    process.env.CODEGRAPH_TIMEOUT_MS = "30";
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const child = createChild({ toolResponseDelay: new Promise<void>(() => { /* never settles; forces a timeout */ }) });
      spawnMock.mockReturnValue(child);
      const controller = new AbortController();
      const mock = createMockPi();
      const { default: codegraphExtension } = await loadExtension();
      codegraphExtension(mock.pi as never);

      const result = mock.tools.get("codegraph_status")!.execute("tool-1", {}, controller.signal, undefined, { cwd: tempRoot });
      await waitFor(() => child.kill.mock.calls.length === 1);
      controller.abort(new Error("user abort"));

      await expect(result).rejects.toThrow("user abort");
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.CODEGRAPH_TIMEOUT_MS;
    }
  });

  it("auto-inits a marker-only project on first non-status query, then retries the original tools/call", async () => {
    await mkdir(path.join(tempRoot, ".codegraph"));
    const firstServe = createChild({ toolError: true, resultText: "Project is not initialized" });
    const secondServe = createChild({ resultText: "search ok" });
    const serveChildren = [firstServe, secondServe];
    const initChildren: FakeChild[] = [];

    spawnMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "serve") {
        const child = serveChildren.shift();
        if (!child) throw new Error("unexpected extra serve spawn");
        return child;
      }
      if (args[0] === "init") {
        const child = createChild({ kind: "init" });
        initChildren.push(child);
        return child;
      }
      throw new Error(`unexpected codegraph command: ${args.join(" ")}`);
    });
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const result = await mock.tools.get("codegraph_search")!.execute(
      "tool-1",
      { query: "SymbolName" },
      undefined,
      undefined,
      { cwd: tempRoot },
    );

    expect(result.content[0].text).toBe("search ok");
    expect(getSpawnSubcommands()).toEqual(["serve", "init", "serve"]);
    expect(spawnMock.mock.calls[0]).toEqual([
      "codegraph",
      ["serve", "--mcp", "--path", tempRoot],
      expect.objectContaining({ cwd: tempRoot }),
    ]);
    expect(spawnMock.mock.calls[1]).toEqual(["codegraph", ["init", tempRoot], expect.objectContaining({ cwd: tempRoot })]);
    expect(spawnMock.mock.calls[2]).toEqual([
      "codegraph",
      ["serve", "--mcp", "--path", tempRoot],
      expect.objectContaining({ cwd: tempRoot }),
    ]);
    expect(initChildren).toHaveLength(1);
    const originalToolCall = getToolCall(firstServe).params;
    expect(originalToolCall).toEqual({
      name: "codegraph_search",
      arguments: { projectPath: tempRoot, query: "SymbolName" },
    });
    expect(getToolCall(secondServe).params).toEqual(originalToolCall);
    expect(firstServe.kill).toHaveBeenCalled();
    expect(secondServe.kill).toHaveBeenCalled();
  });

  it("auto-inits a nested marker project on normal-text unindexed output with canonical projectPath arguments", async () => {
    const projectRoot = await mkdtemp(path.join(tempRoot, "mono-"));
    await mkdir(path.join(projectRoot, ".codegraph"));
    const nested = path.join(projectRoot, "packages", "app");
    await mkdir(nested, { recursive: true });
    const firstServe = createChild({ resultText: `The project at ${projectRoot} isn't indexed with codegraph (no .codegraph/ directory found walking up from it). Run 'codegraph init'.` });
    const secondServe = createChild({ resultText: "search ok" });
    const serveChildren = [firstServe, secondServe];
    const initChildren: FakeChild[] = [];

    spawnMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "serve") {
        const child = serveChildren.shift();
        if (!child) throw new Error("unexpected extra serve spawn");
        return child;
      }
      if (args[0] === "init") {
        const child = createChild({ kind: "init" });
        initChildren.push(child);
        return child;
      }
      throw new Error(`unexpected codegraph command: ${args.join(" ")}`);
    });
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const result = await mock.tools.get("codegraph_search")!.execute(
      "tool-1",
      { projectPath: nested, query: "SymbolName", limit: 3 },
      undefined,
      undefined,
      { cwd: tempRoot },
    );

    expect(result.content[0].text).toBe("search ok");
    expect(getSpawnSubcommands()).toEqual(["serve", "init", "serve"]);
    expect(spawnMock.mock.calls[0]).toEqual([
      "codegraph",
      ["serve", "--mcp", "--path", projectRoot],
      expect.objectContaining({ cwd: projectRoot }),
    ]);
    expect(spawnMock.mock.calls[1]).toEqual(["codegraph", ["init", projectRoot], expect.objectContaining({ cwd: projectRoot })]);
    expect(spawnMock.mock.calls[2]).toEqual([
      "codegraph",
      ["serve", "--mcp", "--path", projectRoot],
      expect.objectContaining({ cwd: projectRoot }),
    ]);
    expect(initChildren).toHaveLength(1);
    const originalToolCall = getToolCall(firstServe).params;
    expect(originalToolCall).toEqual({
      name: "codegraph_search",
      arguments: { projectPath: projectRoot, query: "SymbolName", limit: 3 },
    });
    expect(getToolCall(secondServe).params).toEqual(originalToolCall);
    expect(firstServe.kill).toHaveBeenCalled();
    expect(secondServe.kill).toHaveBeenCalled();
  });

  it("short-circuits non-status queries without spawning when no .codegraph marker exists", async () => {
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const result = await mock.tools.get("codegraph_search")!.execute("tool-1", { query: "SymbolName" }, undefined, undefined, { cwd: tempRoot });
    const text = result.content[0].text;

    expect(text).toContain(`CodeGraph is not enabled for ${tempRoot}.`);
    expect(text).toContain("this tool did not start CodeGraph");
    expect(text).toContain("Use read/rg/fd for this codebase instead");
    expect(text).toContain("codegraph init");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("short-circuits codegraph_files without spawning when no .codegraph marker exists", async () => {
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const result = await mock.tools.get("codegraph_files")!.execute("tool-1", { path: "src" }, undefined, undefined, { cwd: tempRoot });
    const text = result.content[0].text;

    expect(text).toContain(`CodeGraph is not enabled for ${tempRoot}.`);
    expect(text).toContain("this tool did not start CodeGraph");
    expect(text).toContain("Use read/rg/fd for this codebase instead");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not auto-init a ready marker project when the first non-status query succeeds", async () => {
    await mkdir(path.join(tempRoot, ".codegraph"));
    const child = createChild({ resultText: "ready search" });
    spawnMock.mockReturnValue(child);
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const result = await mock.tools.get("codegraph_search")!.execute(
      "tool-1",
      { query: "SymbolName" },
      undefined,
      undefined,
      { cwd: tempRoot },
    );

    expect(result.content[0].text).toBe("ready search");
    expect(getSpawnSubcommands()).toEqual(["serve"]);
    expect(getToolCall(child).params).toEqual({
      name: "codegraph_search",
      arguments: { projectPath: tempRoot, query: "SymbolName" },
    });
    expect(child.kill).toHaveBeenCalled();
  });

  it("returns cold-enabled status text for marker root from normal-text unindexed output without auto-init", async () => {
    const projectRoot = await mkdtemp(path.join(tempRoot, "mono-"));
    await mkdir(path.join(projectRoot, ".codegraph"));
    const nested = path.join(projectRoot, "packages", "app");
    await mkdir(nested, { recursive: true });
    const child = createChild({ resultText: `The project at ${projectRoot} isn't indexed with codegraph (no .codegraph/ directory found walking up from it). Run 'codegraph init'.` });
    spawnMock.mockReturnValue(child);
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const result = await mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: nested });
    const text = result.content[0].text;

    expect(text).toContain(`CodeGraph is enabled for ${projectRoot}, but the index is not built yet.`);
    expect(text).toContain("codegraph_status is inspect-only and did not run codegraph init.");
    expect(text).toContain(`First non-status CodeGraph query will run: codegraph init ${projectRoot}`);
    expect(text).not.toContain("init -i");
    expect(getToolCall(child).params).toEqual({
      name: "codegraph_status",
      arguments: { projectPath: projectRoot },
    });
    expect(getSpawnSubcommands()).toEqual(["serve"]);
    expect(child.kill).toHaveBeenCalled();
  });

  it("ignores invalid ancestor .codegraph past a git directory boundary for status without spawning", async () => {
    await createInvalidGlobalCodeGraph(tempRoot);
    const repoRoot = path.join(tempRoot, "repo");
    const nested = path.join(repoRoot, "app");
    await mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const result = await mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: nested });
    const text = result.content[0].text;

    expect(text).toContain(`CodeGraph is not enabled for ${nested}.`);
    expect(text).toContain("No .codegraph marker was found");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("skips before_agent_start guidance for a git repo under an invalid ancestor .codegraph", async () => {
    await createInvalidGlobalCodeGraph(tempRoot);
    const repoRoot = path.join(tempRoot, "repo");
    const nested = path.join(repoRoot, "app");
    await mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);
    const handler = mock.handlers.get("before_agent_start");
    expect(handler).toBeDefined();

    const result = await handler!({ systemPrompt: "base" }, { cwd: nested });

    expect(result.systemPrompt).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects invalid ancestor .codegraph markers even without a git boundary", async () => {
    await createInvalidGlobalCodeGraph(tempRoot);
    const nested = path.join(tempRoot, "loose", "app");
    await mkdir(nested, { recursive: true });
    const { resolveProjectCwd } = await loadExtension();

    expect(await resolveProjectCwd(nested)).toBe(nested);
  });

  it("does not treat a valid home .codegraph as an implicit marker for non-git descendants", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = tempRoot;
    try {
      await mkdir(path.join(tempRoot, ".codegraph"));
      await writeFile(path.join(tempRoot, ".codegraph", ".gitignore"), "*\n!.gitignore\n");
      const nested = path.join(tempRoot, "loose", "app");
      await mkdir(nested, { recursive: true });
      const { resolveProjectCwd } = await loadExtension();

      expect(await resolveProjectCwd(nested)).toBe(nested);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it.each([
    ["empty", async (marker: string) => {
      await mkdir(marker);
    }],
    [".gitignore", async (marker: string) => {
      await mkdir(marker);
      await writeFile(path.join(marker, ".gitignore"), "*\n!.gitignore\n");
    }],
    ["codegraph.db", async (marker: string) => {
      await mkdir(marker);
      await writeFile(path.join(marker, "codegraph.db"), "");
    }],
  ])("accepts %s .codegraph marker at a git repo root from nested cwd", async (_name, createMarker) => {
    const projectRoot = await mkdtemp(path.join(tempRoot, "repo-"));
    await mkdir(path.join(projectRoot, ".git"));
    await createMarker(path.join(projectRoot, ".codegraph"));
    const nested = path.join(projectRoot, "packages", "app");
    await mkdir(nested, { recursive: true });
    const { resolveProjectCwd } = await loadExtension();

    expect(await resolveProjectCwd(nested)).toBe(projectRoot);
  });

  it("stops at a worktree .git file before an invalid ancestor .codegraph", async () => {
    await createInvalidGlobalCodeGraph(tempRoot);
    const worktreeRoot = path.join(tempRoot, "worktree");
    const nested = path.join(worktreeRoot, "app");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(worktreeRoot, ".git"), "gitdir: /tmp/main/.git/worktrees/worktree\n");
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const result = await mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: nested });
    const text = result.content[0].text;

    expect(text).toContain(`CodeGraph is not enabled for ${nested}.`);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("accepts a marker inside a worktree with a .git file", async () => {
    await createInvalidGlobalCodeGraph(tempRoot);
    const worktreeRoot = path.join(tempRoot, "worktree");
    const nested = path.join(worktreeRoot, "app");
    await mkdir(path.join(worktreeRoot, ".codegraph"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(worktreeRoot, ".git"), "gitdir: /tmp/main/.git/worktrees/worktree\n");
    const child = createChild({ resultText: "status ok" });
    spawnMock.mockReturnValue(child);
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const result = await mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: nested });

    expect(result.content[0].text).toBe("status ok");
    expect(spawnMock).toHaveBeenCalledWith("codegraph", ["serve", "--mcp", "--path", worktreeRoot], expect.objectContaining({ cwd: worktreeRoot }));
  });

  it("short-circuits non-status queries when only an invalid ancestor .codegraph exists", async () => {
    await createInvalidGlobalCodeGraph(tempRoot);
    const repoRoot = path.join(tempRoot, "repo");
    const nested = path.join(repoRoot, "app");
    await mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const result = await mock.tools.get("codegraph_search")!.execute("tool-1", { query: "SymbolName" }, undefined, undefined, { cwd: nested });
    const text = result.content[0].text;

    expect(text).toContain(`CodeGraph is not enabled for ${nested}.`);
    expect(text).toContain("this tool did not start CodeGraph");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
