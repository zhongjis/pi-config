import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analysis: "Primary CTA says Continue.",
  createAgentSession: vi.fn(),
  dispose: vi.fn(),
  abort: vi.fn(),
  prompt: vi.fn(),
  model: {
    provider: "test",
    id: "vision",
    input: ["text", "image"],
  },
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: mocks.createAgentSession,
    DefaultResourceLoader: class {
      async reload() {}
    },
    getAgentDir: () => "/tmp/look-at-test-agent",
    SessionManager: {
      inMemory: vi.fn(() => ({})),
    },
    SettingsManager: {
      create: vi.fn(() => ({})),
    },
  };
});

vi.mock("../../lib/model.js", () => ({
  parseModelChain: vi.fn(() => []),
  resolveFirstAvailable: vi.fn(() => ({
    model: mocks.model,
    thinkingLevel: undefined,
  })),
}));

import multimodalLook from "../index.js";

type ImageBlock = { type: "image"; data: string; mimeType: string };
type TextBlock = { type: "text"; text: string };
type ToolResult = {
  content: Array<TextBlock | ImageBlock>;
  details: Record<string, unknown>;
};
type RenderableText = { render?: (width: number) => string[]; text?: string };
type PlainTheme = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
};
type ToolDefinition = {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<ToolResult>;
  renderResult?: (
    result: ToolResult,
    options: { expanded?: boolean; isPartial?: boolean },
    theme: PlainTheme,
    context?: { args?: Record<string, unknown>; isError?: boolean },
  ) => RenderableText;
};

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7xkAAAAASUVORK5CYII=";
const plainTheme: PlainTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

let testRoot: string;

function registerTool(): ToolDefinition {
  let registered: ToolDefinition | undefined;
  multimodalLook({
    registerTool(tool: ToolDefinition) {
      registered = tool;
    },
  } as never);
  expect(registered).toBeDefined();
  return registered!;
}

function createContext() {
  return {
    cwd: testRoot,
    modelRegistry: {},
    model: undefined,
    sessionManager: { getSessionId: () => "look-at-test-session" },
    hasUI: false,
    ui: { notify: vi.fn() },
  };
}

function renderText(component: RenderableText, width = 120): string {
  if (typeof component.render === "function") return component.render(width).join("\n");
  return component.text ?? "";
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "look-at-contract-"));
  const listeners = new Set<(event: unknown) => void>();
  const session = {
    messages: [],
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: mocks.prompt.mockImplementation(async (_prompt, _options) => {
      for (const listener of listeners) listener({ type: "message_start" });
      for (const listener of listeners) {
        listener({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: mocks.analysis },
        });
      }
    }),
    abort: mocks.abort,
    dispose: mocks.dispose,
  };
  mocks.createAgentSession.mockResolvedValue({ session });
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("look_at result contract", () => {
  it("returns text plus the original file image block", async () => {
    const imageBytes = Buffer.from(PNG_BASE64, "base64");
    await writeFile(join(testRoot, "sample.png"), imageBytes);
    const tool = registerTool();

    const result = await tool.execute(
      "look-at-file",
      { file_path: "sample.png", goal: "Find the primary CTA" },
      undefined,
      undefined,
      createContext(),
    );

    expect(result.content).toEqual([
      { type: "text", text: mocks.analysis },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    ]);
    expect(result.details).toMatchObject({
      mimeType: "image/png",
      bytes: imageBytes.byteLength,
      source: "sample.png",
      model: "test/vision",
      fallback: false,
    });
    expect((result.content[0] as TextBlock).text).not.toContain(PNG_BASE64);

    const collapsed = renderText(
      tool.renderResult!(result, { expanded: false }, plainTheme, {
        args: { file_path: "sample.png", goal: "Find the primary CTA" },
      }),
    );
    const expanded = renderText(
      tool.renderResult!(result, { expanded: true }, plainTheme, {
        args: { file_path: "sample.png", goal: "Find the primary CTA" },
      }),
    );
    expect(collapsed).toContain(`findings: ${mocks.analysis}`);
    expect(expanded).toBe(mocks.analysis);
    expect(`${collapsed}\n${expanded}`).not.toContain(PNG_BASE64);
  });

  it("preserves data URI MIME and canonical image bytes", async () => {
    const gifBytes = Buffer.from("GIF89a", "ascii");
    const gifBase64 = gifBytes.toString("base64");
    const tool = registerTool();

    const result = await tool.execute(
      "look-at-data-uri",
      {
        image_data: `data:image/gif;base64,${gifBase64}`,
        goal: "Identify the image format",
      },
      undefined,
      undefined,
      createContext(),
    );

    expect(result.content).toEqual([
      { type: "text", text: mocks.analysis },
      { type: "image", data: gifBase64, mimeType: "image/gif" },
    ]);
    expect(result.details).toMatchObject({
      mimeType: "image/gif",
      bytes: gifBytes.byteLength,
      source: "image_data",
    });
  });

  it("rejects unsupported MIME without exposing image data", async () => {
    const suppliedBase64 = Buffer.from("private-bitmap-bytes").toString("base64");
    const tool = registerTool();

    let thrown: unknown;
    try {
      await tool.execute(
        "look-at-bmp",
        {
          image_data: `data:image/bmp;base64,${suppliedBase64}`,
          goal: "Inspect bitmap",
        },
        undefined,
        undefined,
        createContext(),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'look_at unsupported mime_type "image/bmp". Supported: image/png, image/jpeg, image/webp, image/gif.',
    );
    expect((thrown as Error).message).not.toContain(suppliedBase64);
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
  });
});
