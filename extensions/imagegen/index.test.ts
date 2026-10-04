import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { get, request, type RequestOptions } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext, RegisteredCommand, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockPi } from "../../test/fixtures/mock-pi.js";
import imagegen from "./index.js";

const processMocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: processMocks.spawn }));

const credential = "synthetic-oauth-credential";
const imageFixtures: Record<string, string> = {"png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVQI12NoAAAAggCB3UNq9AAAAABJRU5ErkJggg==", "jpeg": "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==", "webp": "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vuUAAA="};
const bytes = Buffer.from(imageFixtures.png, "base64");

function imageResponse(format?: string): Response {
  return Response.json({ data: [{ b64_json: imageFixtures[format ?? "png"] ?? imageFixtures.png, revised_prompt: "Revised fixture" }], ...(format ? { output_format: format } : {}) });
}

function localRequest(url: string | URL, options: RequestOptions = {}, body?: string | Buffer): Promise<{ status: number | undefined; body: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request(url, options, (response) => {
      // End even an erroneously admitted SSE request so a failed guard cannot hang the test.
      if (response.headers["content-type"]?.startsWith("text/event-stream")) {
        resolve({ status: response.statusCode, body: "", contentType: response.headers["content-type"] });
        response.destroy();
        return;
      }
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: text, contentType: response.headers["content-type"] }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function localGet(url: string): Promise<string> {
  return (await localRequest(url)).body;
}

describe("vendored imagegen public registration", () => {
  let dir: string;
  let mock: ReturnType<typeof createMockPi>;
  let pi: ExtensionAPI;
  let tool: ToolDefinition;
  let command: RegisteredCommand;
  let context: ExtensionToolContext & ExtensionCommandContext;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let apiKey: ReturnType<typeof vi.fn<ExtensionToolContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
  let oauth: ReturnType<typeof vi.fn>;
  let available: ReturnType<typeof vi.fn>;
  const proxy = { provider: "cliproxyapi", id: "chat-anchor", baseUrl: "http://proxy.example/backend-api/codex" };
  const official = { provider: "openai", id: "official-anchor", baseUrl: "https://api.openai.com/v1" };

  beforeEach(async () => {
    official.baseUrl = "https://api.openai.com/v1";
    dir = await mkdtemp(join(tmpdir(), "pi-imagegen-test-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(imageResponse());
    vi.stubGlobal("fetch", fetchMock);
    apiKey = vi.fn<ExtensionToolContext["modelRegistry"]["getApiKeyAndHeaders"]>().mockResolvedValue({ ok: true, apiKey: credential });
    oauth = vi.fn().mockReturnValue(true);
    available = vi.fn().mockReturnValue([proxy, official]);
    context = {
      cwd: dir, hasUI: true, signal: undefined,
      model: { provider: "openai-codex", id: "dispatcher-fixture" },
      modelRegistry: { getAll: () => [proxy, official], getAvailable: available, getApiKeyAndHeaders: apiKey, isUsingOAuth: oauth },
      ui: { notify: vi.fn(), setStatus: vi.fn(), getEditorText: () => "", setEditorText: vi.fn() },
    } as unknown as ExtensionToolContext & ExtensionCommandContext;
    mock = createMockPi();
    vi.spyOn(mock.pi, "sendMessage");
    let registeredTool: ToolDefinition | undefined;
    let registeredCommand: RegisteredCommand | undefined;
    pi = {
      ...mock.pi,
      registerTool(definition: ToolDefinition) {
        mock.pi.registerTool(definition);
        registeredTool = definition;
      },
      registerCommand(name: string, definition: Omit<RegisteredCommand, "name">) {
        mock.pi.registerCommand(name, definition);
        registeredCommand = { name, ...definition };
      },
    } as unknown as ExtensionAPI;
    imagegen(pi);
    if (!registeredTool || !registeredCommand) throw new Error("Missing imagegen registrations");
    tool = registeredTool;
    command = registeredCommand;
  });

  afterEach(async () => {
    await mock.fireLifecycle("session_shutdown");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    processMocks.spawn.mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  it("hides imagegen without an available configured chain candidate", async () => {
    await writeFile(join(dir, "tool_models.json"), JSON.stringify({ version: 1, tools: { "imagegen.generate": { chain: "cliproxyapi/gpt-image-2.5" } } }));
    available.mockReturnValue([]);
    await mock.fireLifecycle("session_start", {}, context);
    expect(mock.tools.get("imagegen")).toMatchObject({ exposure: "hidden" });
    expect(apiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  async function configureChain(chain: string | null) {
    await writeFile(join(dir, "tool_models.json"), JSON.stringify({ version: 1, tools: { "imagegen.generate": { role: null, chain } } }));
  }

  it.each(["gpt-image-2", "gpt-image-2.5", "gpt-image-2.5-sunburst"])("keeps imagegen visible for an available fallback image candidate (%s)", async (model) => {
    await configureChain(`openai-codex/gpt-image-2.5,unsupported/no-image,cliproxyapi/${model}`);
    available.mockReturnValue([proxy]);
    const register = vi.spyOn(mock.pi, "registerTool");
    await mock.fireLifecycle("session_start", {}, context);
    await mock.fireLifecycle("before_agent_start", {}, context);
    expect(mock.tools.get("imagegen")).not.toHaveProperty("exposure", "hidden");
    expect(register).not.toHaveBeenCalled();
    expect(apiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    null, "", " , ", "not-a-model", "gpt-image-2.5", "cliproxyapi/gpt-image",
    "CLIPROXYAPI/gpt-image-2.5", "cliproxyapi/gpt-image-2-5", "cliproxyapi/unsupported",
    "unsupported/gpt-image-2.5", "openai-codex/gpt-image-2.5", "openai-codex/dispatcher-fixture",
  ])("hides imagegen for an ineligible configured chain (%s)", async (chain) => {
    await configureChain(chain);
    await mock.fireLifecycle("session_start", {}, context);
    expect(mock.tools.get("imagegen")).toHaveProperty("exposure", "hidden");
  });

  it("hides imagegen for malformed configuration without a lower-layer selection", async () => {
    await configureChain(null);
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi/tool_models.json"), "{malformed");
    await mock.fireLifecycle("session_start", {}, context);
    expect(mock.tools.get("imagegen")).toHaveProperty("exposure", "hidden");
  });

  it.each(["unavailable anchor", "missing anchor", "billing auth", "nonofficial base"])("hides imagegen for %s", async (reason) => {
    await configureChain("openai/gpt-image-2.5");
    if (reason === "unavailable anchor") available.mockReturnValue([proxy, { ...official, id: "different-anchor" }]);
    if (reason === "missing anchor") {
      vi.spyOn(context.modelRegistry, "getAll").mockReturnValue([]);
    }
    if (reason === "billing auth") oauth.mockReturnValue(false);
    if (reason === "nonofficial base") official.baseUrl = "https://other.example/v1";
    await mock.fireLifecycle("session_start", {}, context);
    expect(mock.tools.get("imagegen")).toHaveProperty("exposure", "hidden");
    expect(apiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps imagegen visible for an eligible official OAuth anchor", async () => {
    await configureChain("openai/gpt-image-2.5");
    official.baseUrl = "https://api.openai.com/v1/";
    await mock.fireLifecycle("session_start", {}, context);
    expect(oauth).toHaveBeenCalledWith(official);
    expect(mock.tools.get("imagegen")).not.toHaveProperty("exposure", "hidden");
    expect(apiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["config", "auth"])("withdraws imagegen after its fallback chain becomes unavailable (%s)", async (loss) => {
    await configureChain("cliproxyapi/gpt-image-2.5");
    await mock.fireLifecycle("session_start", {}, context);
    expect(mock.tools.get("imagegen")).not.toHaveProperty("exposure", "hidden");
    if (loss === "config") await configureChain("unsupported/no-image");
    else available.mockReturnValue([]);
    await mock.fireLifecycle("before_agent_start", {}, context);
    expect(mock.tools.get("imagegen")).toMatchObject({ exposure: "hidden", execute: tool.execute, parameters: tool.parameters, renderResult: tool.renderResult });
  });

  it.each([
    ["before", true], ["after", true], ["before", false], ["after", false],
  ] as const)("does not activate imagegen outside the active tool policy (%s, allowed=%s)", async (order, allowed) => {
    await configureChain("cliproxyapi/gpt-image-2.5");
    mock.pi.registerTool({ name: "other-tool" });
    const active = allowed ? ["other-tool", "imagegen"] : ["other-tool"];
    vi.spyOn(mock.pi, "getActiveTools").mockImplementation(() => [...active]);
    const register = vi.spyOn(mock.pi, "registerTool");
    const activate = vi.spyOn(mock.pi, "setActiveTools");
    const policy = () => { mock.pi.setActiveTools(); };
    const handlers = mock.lifecycleHandlers.get("session_start") ?? [];
    if (order === "before") handlers.unshift(policy);
    else handlers.push(policy);
    await mock.fireLifecycle("session_start", {}, context);
    await mock.fireLifecycle("before_agent_start", {}, context);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
    expect(mock.pi.getActiveTools()).toEqual(active);
    expect(mock.tools.has("other-tool")).toBe(true);
    available.mockReturnValue([]);
    await mock.fireLifecycle("before_agent_start", {}, context);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(mock.tools.has("other-tool")).toBe(true);
    expect(mock.tools.get("imagegen")).toHaveProperty("exposure", "hidden");
  });

  it("preserves manual image workflows while imagegen is hidden", async () => {
    await configureChain(null);
    await mock.fireLifecycle("session_start", {}, context);
    await mock.fireLifecycle("before_agent_start", {}, context);
    expect(mock.tools.get("imagegen")).toHaveProperty("exposure", "hidden");
    expect(apiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await command.handler("gen --provider cliproxyapi --model gpt-image-2.5 A fixture", context);
    expect(apiKey).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await command.handler("list", context);
    expect(mock.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ details: { recent: [expect.objectContaining({ provider: "cliproxyapi" })] } }));
    let studioUrl = "";
    processMocks.spawn.mockImplementation((_command: string, args: string[]) => {
      studioUrl = args[0];
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    await command.handler("studio", context);
    expect(await localGet(studioUrl)).toContain("<title>Pi Image Studio</title>");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("restores eligibility only in a fresh extension instance", async () => {
    await configureChain("cliproxyapi/gpt-image-2.5");
    available.mockReturnValue([]);
    await mock.fireLifecycle("session_start", {}, context);
    available.mockReturnValue([proxy]);
    const register = vi.spyOn(mock.pi, "registerTool");
    await mock.fireLifecycle("session_start", {}, context);
    await mock.fireLifecycle("before_agent_start", {}, context);
    expect(register).not.toHaveBeenCalled();
    expect(mock.tools.get("imagegen")).toHaveProperty("exposure", "hidden");
    await mock.fireLifecycle("session_shutdown");
    mock.lifecycleHandlers.clear();
    mock.tools.clear();
    mock.toolRegistrations.length = 0;
    imagegen(pi);
    await mock.fireLifecycle("session_start", {}, context);
    expect(mock.tools.get("imagegen")).not.toHaveProperty("exposure", "hidden");
    expect(mock.toolRegistrations).toHaveLength(1);
  });

  it("registers once, sends direct edits and preserves saved history and events", async () => {
    expect(mock.toolRegistrations.map((entry) => entry.name)).toEqual(["imagegen"]);
    expect(mock.commands.has("img")).toBe(true);
    expect(mock.renderers.has("imagegen-result")).toBe(true);
    const references = ["jpg", "png", "webp"].map((ext) => join(dir, `reference.${ext}`));
    for (const path of references) await writeFile(path, bytes);
    const update = vi.fn();
    const emit = vi.spyOn(mock.pi.events, "emit");
    const result = await tool.execute("fixture", { prompt: "A fixture", referencePaths: references }, undefined, update, context);
    expect(apiKey).toHaveBeenCalledWith(proxy);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://proxy.example/v1/images/edits");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ model: "gpt-image-2.5", prompt: "A fixture", n: 1, size: "auto", quality: "auto", background: "auto", output_format: "png", images: ["jpeg", "png", "webp"].map((format) => ({ image_url: `data:image/${format};base64,${bytes.toString("base64")}` })) });
    expect(update).toHaveBeenCalled();
    expect(result.content).toContainEqual({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
    const metadata = JSON.parse(JSON.stringify(result.details));
    expect(metadata).toMatchObject({ prompt: "A fixture", revisedPrompt: "Revised fixture", provider: "cliproxyapi", imageModel: "gpt-image-2.5", responseModel: "none", thinking: "off" });
    expect(await readFile(metadata.savedPath)).toEqual(bytes);
    expect(JSON.parse(await readFile(metadata.metadataPath, "utf8"))).toEqual(metadata);
    expect(JSON.parse(await readFile(join(dir, "generated-images/index", `${metadata.imageId}.json`), "utf8"))).toEqual(metadata);
    expect(emit).toHaveBeenCalledWith("imagegen:generated", metadata);
    await command.handler("list", context);
    expect(mock.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ details: { recent: [metadata] } }));
  });

  it.each(["gpt-image-2", "gpt-image-2.5", "gpt-image-2.5-sunburst"])("selects %s directly and records the selection", async (imageModel) => {
    const result = await tool.execute("fixture", { prompt: "Fixture", imageModel, thinking: "high", size: "1024x1024", quality: "low", background: "opaque" }, undefined, undefined, context);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://proxy.example/v1/images/generations");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ model: imageModel, n: 1, size: "1024x1024", quality: "low", background: "opaque" });
    for (const key of ["reasoning", "tools", "stream", "response_format", "output_compression"]) expect(body[key]).toBeUndefined();
    expect(result.details).toMatchObject({ imageModel, responseModel: "none", thinking: "off" });
  });

  it.each(["https://override.example/prefix/backend-api/codex/", "https://override.example/prefix/v1"])("honors resolved proxy base %s and header removal", async (baseUrl) => {
    apiKey.mockResolvedValue({ ok: true, apiKey: credential, baseUrl, headers: { Authorization: null, "x-api-key": "header-credential" } });
    await tool.execute("fixture", { prompt: "Fixture" }, undefined, undefined, context);
    expect(fetchMock.mock.calls[0][0]).toBe("https://override.example/prefix/v1/images/generations");
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBe("header-credential");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("uses official OAuth resolution and exact official endpoint without legacy headers", async () => {
    apiKey.mockResolvedValue({ ok: true, apiKey: credential, baseUrl: "https://api.openai.com/v1/", headers: { Authorization: `Bearer ${credential}`, "x-request-label": "fixture" } });
    const result = await tool.execute("fixture", { prompt: "Fixture", provider: "openai" }, undefined, undefined, context);
    expect(apiKey).toHaveBeenCalledWith(official);
    expect(oauth).toHaveBeenCalledWith(official);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/images/generations");
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${credential}`);
    for (const name of ["chatgpt-account-id", "openai-beta", "session_id"]) expect(headers.has(name)).toBe(false);
    expect(result.details).toMatchObject({ provider: "openai" });
  });

  it.each<Record<string, string | null>>([
    { Authorization: "Bearer sk-billing" }, { authorization: null }, { AUTHORIZATION: "Bearer other-token" },
    { "API-Key": "billing" }, { "OpenAI-Api-Key": "billing" }, { "X-Api-Key": "billing" },
  ])("rejects official credential header overrides %j", async (headers) => {
    apiKey.mockResolvedValue({ ok: true, apiKey: credential, headers });
    await expect(tool.execute("fixture", { prompt: "Fixture", provider: "openai" }, undefined, undefined, context)).rejects.toThrow("credential header overrides");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it.each([undefined, "", "   ", "sk-billing"])("requires a resolved OAuth token (%s)", async (key) => {
    apiKey.mockResolvedValue({ ok: true, apiKey: key });
    await expect(tool.execute("fixture", { prompt: "Fixture", provider: "openai" }, undefined, undefined, context)).rejects.toThrow("resolved OAuth token");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it.each(["model", "auth"])("rejects nonofficial %s base URLs", async (source) => {
    if (source === "model") official.baseUrl = "https://other.example/v1";
    else apiKey.mockResolvedValue({ ok: true, apiKey: credential, baseUrl: "https://other.example/v1" });
    await expect(tool.execute("fixture", { prompt: "Fixture", provider: "openai" }, undefined, undefined, context)).rejects.toThrow("exact https://api.openai.com/v1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it("accepts proxy header-only credentials", async () => {
    apiKey.mockResolvedValue({ ok: true, headers: { Authorization: null, "X-Api-Key": credential } });
    await tool.execute("fixture", { prompt: "Fixture" }, undefined, undefined, context);
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBe(credential);
  });

  it("sanitizes invalid header configuration before fetch", async () => {
    apiKey.mockResolvedValue({ ok: true, apiKey: credential, headers: { "X-Api-Key": `secret-value\n${credential}` } });
    await expect(tool.execute("fixture", { prompt: "Fixture" }, undefined, undefined, context)).rejects.toThrow(/^Invalid Images API header configuration\.$/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it("sanitizes malformed success JSON", async () => {
    fetchMock.mockResolvedValue(new Response(`secret-value ${credential}`, { status: 200 }));
    await expect(tool.execute("fixture", { prompt: "Fixture" }, undefined, undefined, context)).rejects.toThrow(/^Invalid Images API JSON response\.$/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("preserves transport abort classification without reflecting errors", async () => {
    fetchMock.mockRejectedValue(new DOMException(`secret-value ${credential}`, "AbortError"));
    await expect(tool.execute("fixture", { prompt: "Fixture" }, undefined, undefined, context)).rejects.toMatchObject({ name: "AbortError", message: "Request was aborted" });
    expect(await readdir(dir)).toEqual([]);
  });

  it.each([
    { data: [{ b64_json: Buffer.from("not an image").toString("base64") }] },
    { data: [{ b64_json: imageFixtures.png }], output_format: "jpeg" },
    { data: [{ b64_json: imageFixtures.jpeg }], output_format: "webp" },
    { data: [{ b64_json: imageFixtures.webp }], output_format: "png" },
  ])("rejects invalid or mismatched image signatures", async (body) => {
    fetchMock.mockResolvedValue(Response.json(body));
    await expect(tool.execute("fixture", { prompt: "Fixture" }, undefined, undefined, context)).rejects.toThrow("image signature");
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects official API-key billing before credential resolution or fetch", async () => {
    oauth.mockReturnValue(false);
    await expect(tool.execute("fixture", { prompt: "Fixture", provider: "openai" }, undefined, undefined, context)).rejects.toThrow("API-key billing is not used");
    expect(apiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it("reports the actual official denial with bounded redaction and no fallback", async () => {
    apiKey.mockResolvedValue({ ok: true, apiKey: credential, headers: { "x-secret": "header-secret" } });
    fetchMock.mockResolvedValue(Response.json({ error: { message: `This ChatPass credential is not authorized for the requested operation. ${credential} header-secret ${"x".repeat(1000)}` } }, { status: 401 }));
    const error = await tool.execute("fixture", { prompt: "Fixture", provider: "openai" }, undefined, undefined, context).catch((error: unknown) => error);
    expect(error).toMatchObject({ name: "ImageRequestError", status: 401 });
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected error");
    expect(error.message).toContain("This ChatPass credential is not authorized");
    expect(error.message).toContain("No billing key or provider fallback");
    expect(error.message).not.toContain(credential);
    expect(error.message).not.toContain("header-secret");
    expect(error.message.length).toBeLessThan(900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it.each(["jpeg", "webp"])("honors returned %s format and compression only for lossy requests", async (format) => {
    fetchMock.mockResolvedValue(imageResponse(format));
    const result = await tool.execute("fixture", { prompt: "Fixture", outputFormat: format }, undefined, undefined, context);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ output_format: format, output_compression: 100 });
    expect(result.details).toMatchObject({ mimeType: `image/${format}`, outputFormat: format });
  });

  it("uses returned format rather than requested format for MIME and default extension", async () => {
    fetchMock.mockResolvedValue(imageResponse("webp"));
    const result = await tool.execute("fixture", { prompt: "Fixture" }, undefined, undefined, context);
    expect(result.details).toMatchObject({ mimeType: "image/webp", outputFormat: "webp", savedPath: expect.stringMatching(/\.webp$/) });
  });

  it("fails without auth before fetch or saving", async () => {
    apiKey.mockResolvedValue({ ok: false, error: "sensitive auth details" });
    await expect(tool.execute("fixture", { prompt: "Fixture" }, undefined, undefined, context)).rejects.toThrow("Could not resolve cliproxyapi credentials");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it.each([
    { prompt: "" }, { prompt: "   " }, { prompt: "Fixture", provider: "other" },
    { prompt: "Fixture", imageModel: "gpt-5" }, { prompt: "Fixture", size: "wrong" },
    { prompt: "Fixture", quality: "wrong" }, { prompt: "Fixture", outputFormat: "gif" },
    { prompt: "Fixture", background: "wrong" }, { prompt: "Fixture", referencePaths: [1] },
  ])("rejects invalid parameters %j before side effects", async (params) => {
    await expect(tool.execute("fixture", params, undefined, undefined, context)).rejects.toThrow("Invalid image parameters");
    expect(apiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it.each([
    ["HTTP failure", () => new Response("backend unavailable", { status: 503 }), "503"],
    ["missing output", () => Response.json({ data: [] }), "Invalid Images API response"],
    ["remote URL", () => Response.json({ data: [{ url: "https://arbitrary.example/image" }] }), "Invalid Images API response"],
    ["empty base64", () => Response.json({ data: [{ b64_json: "" }] }), "Invalid Images API response"],
    ["invalid base64", () => Response.json({ data: [{ b64_json: "!!!!" }] }), "base64"],
    ["invalid format", () => imageResponse("gif"), "Invalid Images API response"],
  ])("propagates %s without saving", async (_name, response, message) => {
    fetchMock.mockResolvedValue(response());
    await expect(tool.execute("fixture", { prompt: "Fixture" }, undefined, undefined, context)).rejects.toThrow(message);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it("forwards abort signal and stops before saving", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute("fixture", { prompt: "Fixture" }, controller.signal, undefined, context)).rejects.toThrow("aborted");
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(await readdir(dir)).toEqual([]);
  });

  it("sanitizes fetch rejection once without saving", async () => {
    fetchMock.mockRejectedValue(new Error(`network fixture ${credential}`));
    await expect(tool.execute("fixture", { prompt: "Fixture" }, undefined, undefined, context)).rejects.toThrow("Images API transport failed. Check connectivity and provider configuration.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it("runs /img batches with provider/model flags and preserves indexed batch metadata", async () => {
    fetchMock.mockResolvedValueOnce(imageResponse()).mockResolvedValueOnce(imageResponse());
    await command.handler("batch 2 --provider cliproxyapi --model gpt-image-2.5-sunburst --style poster fixture", context);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const paths = await readdir(join(dir, "generated-images/index"));
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      const metadata = JSON.parse(await readFile(join(dir, "generated-images/index", path), "utf8"));
      expect(metadata).toMatchObject({ batchPrompt: "fixture", batchCount: 2, thinking: "off", provider: "cliproxyapi", imageModel: "gpt-image-2.5-sunburst", quality: "high" });
      expect(await readFile(metadata.savedPath)).toEqual(bytes);
    }
  });

  it("passes /img gen image-model alias through styles", async () => {
    await command.handler("gen --provider openai --image-model gpt-image-2 --style poster fixture", context);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ model: "gpt-image-2", quality: "high" });
    expect(apiKey).toHaveBeenCalledWith(official);
  });

  it("rejects unauthenticated and cross-origin studio requests before side effects", async () => {
    let studioUrl = "";
    processMocks.spawn.mockImplementation((_command: string, args: string[]) => {
      studioUrl = args[0];
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    await command.handler("studio", context);
    processMocks.spawn.mockClear();
    const status = vi.mocked(context.ui.setStatus);
    status.mockClear();
    const emit = vi.spyOn(mock.pi.events, "emit");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const routes = ["/", "/studio", "/api/images", "/api/image/fixture", "/api/generate", "/api/sketch", "/api/open", "/api/reveal", "/api/insert", "/api/future", "/events"];
    for (const path of routes) {
      for (const mode of ["missing", "wrong", "foreign", "null", "empty-origin", "host"]) {
        const url = new URL(studioUrl);
        url.pathname = path;
        const headers: Record<string, string> = { "Content-Type": "text/plain" };
        if (mode === "missing") url.search = "";
        if (mode === "wrong") url.searchParams.set("token", "wrong");
        if (mode === "foreign") headers.Origin = "https://attacker.example";
        if (mode === "null") headers.Origin = "null";
        if (mode === "empty-origin") headers.Origin = "";
        if (mode === "host") headers.Host = "attacker.example";
        const post = ["/api/generate", "/api/sketch", "/api/open", "/api/reveal", "/api/insert"].includes(path);
        const body = path === "/api/sketch" ? png : JSON.stringify({ prompt: "Malicious fixture", imageId: "fixture" });
        const response = await localRequest(url, { method: post ? "POST" : "GET", headers }, post ? body : undefined);
        expect(response, `${mode} ${path}`).toMatchObject({ status: 403, body: "Forbidden" });
        expect(response.contentType).not.toContain("text/event-stream");
      }
    }
    expect(apiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(processMocks.spawn).not.toHaveBeenCalled();
    expect(context.ui.setEditorText).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);

    for (const path of ["/", "/studio", "/api/images", "/api/generate"]) {
      const url = new URL(studioUrl);
      url.pathname = path;
      const generate = path === "/api/generate";
      const response = await localRequest(url, { method: generate ? "POST" : "GET", headers: { Origin: url.origin, "Content-Type": "application/json" } }, generate ? JSON.stringify({ prompt: "Authorized fixture", provider: "cliproxyapi", imageModel: "gpt-image-2.5-sunburst" }) : undefined);
      expect(response.status).toBe(200);
      if (path === "/" || path === "/studio") expect(response.body).toContain("<title>Pi Image Studio</title>");
      if (path === "/api/images") expect(JSON.parse(response.body)).toEqual({ images: [] });
      if (generate) expect(JSON.parse(response.body).images[0]).toMatchObject({ provider: "cliproxyapi", imageModel: "gpt-image-2.5-sunburst" });
    }
    const invalidUrl = new URL(studioUrl);
    invalidUrl.pathname = "/api/generate";
    for (const invalid of [{ provider: "other" }, { imageModel: "wrong" }, { size: "wrong" }, { prompt: 42 }]) {
      expect((await localRequest(invalidUrl, { method: "POST" }, JSON.stringify({ prompt: "Fixture", ...invalid }))).status).toBe(400);
    }
    expect(apiKey).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await readdir(join(dir, "generated-images/index"))).toHaveLength(1);
    const imagesUrl = new URL(studioUrl);
    imagesUrl.pathname = "/api/images";
    expect((await localRequest(imagesUrl)).status).toBe(200);
    expect((await localRequest(new URL("/favicon.ico", studioUrl))).status).toBe(204);
  });

  it("starts local studio, serves upstream page and closes server plus SSE on repeated shutdown", async () => {
    let studioUrl = "";
    processMocks.spawn.mockImplementation((_command: string, args: string[]) => {
      studioUrl = args[0];
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    await command.handler("studio", context);
    expect(studioUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/studio\?token=/);
    expect(await localGet(studioUrl)).toContain("<title>Pi Image Studio</title>");
    const ended = new Promise<void>((resolve, reject) => {
      const eventsUrl = new URL(studioUrl);
      eventsUrl.pathname = "/events";
      get(eventsUrl, { headers: { Origin: eventsUrl.origin } }, (response) => {
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toContain("text/event-stream");
        response.once("data", async () => {
          try { await mock.fireLifecycle("session_shutdown"); } catch (error) { reject(error); }
        });
        response.on("end", resolve);
        response.on("error", reject);
        response.resume();
      }).on("error", reject);
    });
    await ended;
    await mock.fireLifecycle("session_shutdown");
    await expect(localGet(studioUrl)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
