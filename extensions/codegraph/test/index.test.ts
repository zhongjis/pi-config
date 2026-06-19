import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  spawn: spawnMock,
}));

type ToolDefinition = {
  name: string;
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
  errorOnInitialize?: Error;
  resultText?: string;
  toolError?: boolean;
  toolResponseDelay?: Promise<void>;
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

async function loadExtension() {
  const module = await import("../index.js");
  return module;
}

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

  it("adds before_agent_start guidance without spawning CodeGraph", async () => {
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();

    codegraphExtension(mock.pi as never);
    const handler = mock.handlers.get("before_agent_start");
    expect(handler).toBeDefined();
    const result = await handler!({ systemPrompt: "base" }, { cwd: tempRoot });

    expect(result.systemPrompt).toContain("base");
    expect(result.systemPrompt).toContain("CodeGraph tools are available as codegraph_* Pi tools.");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("uses ctx.cwd as default projectPath for codegraph_status", async () => {
    const child = createChild({ resultText: "status ok" });
    spawnMock.mockReturnValue(child);
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    const result = await mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: tempRoot });

    expect(result.content[0].text).toBe("status ok");
    expect(spawnMock).toHaveBeenCalledWith("codegraph", ["serve", "--mcp", "--path", tempRoot], {
      cwd: tempRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(child.kill).toHaveBeenCalled();
  });

  it("lets explicit projectPath override ctx.cwd", async () => {
    const projectPath = await mkdtemp(path.join(tempRoot, "override-"));
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

  it("rejects when the CodeGraph CLI cannot spawn", async () => {
    spawnMock.mockReturnValue(createChild({ errorOnInitialize: new Error("spawn codegraph ENOENT") }));
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    await expect(
      mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: tempRoot }),
    ).rejects.toThrow("spawn codegraph ENOENT");
  });

  it("normalizes absolute codegraph_files path inside ctx.cwd", async () => {
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

  it("cleans up pending MCP session on tool error", async () => {
    const child = createChild({ resultText: "tool failed", toolError: true });
    spawnMock.mockReturnValue(child);
    const mock = createMockPi();
    const { default: codegraphExtension } = await loadExtension();
    codegraphExtension(mock.pi as never);

    await expect(
      mock.tools.get("codegraph_status")!.execute("tool-1", {}, undefined, undefined, { cwd: tempRoot }),
    ).rejects.toThrow("tool failed");
    expect(child.kill).toHaveBeenCalled();
  });

  it("serializes concurrent calls for the same project", async () => {
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
});
