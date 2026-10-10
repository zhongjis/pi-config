import type { ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import filterOutputs from "../index.js";

const MiB = 1024 * 1024;
const OPENAI_KEY = `sk-${"a1".repeat(12)}`;
const PASSWORD = "hunter2-correct-horse";
const NOTICE = "🔒 Sensitive data redacted from output";

function setup() {
  const mock = createMockPi();
  filterOutputs(mock.pi as never);
  const [handler] = mock.lifecycleHandlers.get("tool_result") ?? [];
  const notify = vi.fn();
  const run = async (event: Record<string, unknown>) =>
    (await handler(
      {
        type: "tool_result",
        toolCallId: "call-1",
        input: {},
        isError: false,
        ...event,
      },
      { ui: { notify } },
    )) as ToolResultEventResult | undefined;
  return { run, notify };
}

const text = (value: string) => ({ type: "text", text: value });

describe("filter-outputs tool_result", () => {
  it("redacts content and structuredContent of an isError bash result without touching isError", async () => {
    const { run } = setup();

    const result = await run({
      toolName: "bash",
      input: { command: "psql" },
      isError: true,
      details: undefined,
      content: [text(`connecting postgres://app:${PASSWORD}@db:5432/app\nexit code 1`)],
      structuredContent: {
        output: `key ${OPENAI_KEY}`,
        truncated: false,
        exit_code: 1,
        wall_time_seconds: 0.2,
      },
    });

    expect(result).toStrictEqual({
      content: [text("connecting postgres://app:[REDACTED]@db:5432/app\nexit code 1")],
      structuredContent: {
        output: "key [OPENAI_KEY_REDACTED]",
        truncated: false,
        exit_code: 1,
        wall_time_seconds: 0.2,
      },
    });
    expect(result).not.toHaveProperty("isError");
    expect(result).not.toHaveProperty("details");
    expect(result).not.toHaveProperty("usage");
  });

  it("redacts a thrown-error-shaped result", async () => {
    const { run } = setup();

    const result = await run({
      toolName: "mcporter",
      isError: true,
      details: {},
      content: [text(`Error: auth failed for token=${PASSWORD}`)],
    });

    expect(result).toStrictEqual({ content: [text("Error: auth failed for token=[REDACTED]")] });
  });

  it("redacts a secret in text block 2 and keeps block 1 unchanged (codemode shape)", async () => {
    const { run } = setup();
    const header = text("Script completed in 12ms");

    const result = await run({
      toolName: "codemode",
      content: [header, text(`stdout: ${OPENAI_KEY}`)],
    });

    expect(result?.content).toStrictEqual([header, text("stdout: [OPENAI_KEY_REDACTED]")]);
    expect(result?.content?.[0]).toBe(header);
  });

  it("keeps images and extra text blocks in order when block 1 is redacted", async () => {
    const { run } = setup();
    const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
    const tail = text("page 2");

    const result = await run({
      toolName: "mcp",
      content: [text(`password=${PASSWORD}`), image, tail],
    });

    expect(result?.content).toStrictEqual([text("password=[REDACTED]"), image, tail]);
    expect(result?.content?.[1]).toBe(image);
    expect(result?.content?.[2]).toBe(tail);
  });

  it("redacts structuredContent string leaves and preserves its shape", async () => {
    const { run } = setup();
    const content = [text("done")];

    const result = await run({
      toolName: "bash",
      parentToolCallId: "call-0",
      toolCallId: "call-0/1",
      content,
      structuredContent: {
        output: `export api_key="${"k".repeat(24)}"`,
        exit_code: 0,
        truncated: false,
        meta: {
          tags: ["ok", `Bearer ${"t".repeat(24)}`, 3, null, { deep: `password=${PASSWORD}` }],
          ratio: 0.5,
        },
      },
    });

    expect(result).toStrictEqual({
      content,
      structuredContent: {
        output: "export api_key=[REDACTED]",
        exit_code: 0,
        truncated: false,
        meta: {
          tags: ["ok", "Bearer [REDACTED]", 3, null, { deep: "password=[REDACTED]" }],
          ratio: 0.5,
        },
      },
    });
  });

  it("returns clean structuredContent with redacted content so pi keeps it", async () => {
    const { run } = setup();
    const structuredContent = { output: "clean", exit_code: 0 };

    const result = await run({
      toolName: "bash",
      content: [text(`password=${PASSWORD}`)],
      structuredContent,
    });

    expect(result).toStrictEqual({
      content: [text("password=[REDACTED]")],
      structuredContent,
    });
  });

  describe("fails closed on structuredContent", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: unknown = "leaf";
    for (let i = 0; i < 100; i++) deep = [deep];
    const half = "a".repeat(Math.floor(1.5 * MiB));

    it.each([
      ["a Date", { at: new Date(0) }],
      ["a bigint", { n: 1n }],
      ["a function", { fn: () => {} }],
      ["a cycle", cyclic],
      ["nesting past the depth limit", deep],
      ["one string over the size cap", { output: "a".repeat(2 * MiB + 1) }],
      ["strings over the size cap in total", [half, half]],
    ])("drops structuredContent with %s", async (_label, structuredContent) => {
      const { run } = setup();
      const content = [text("clean")];

      const result = await run({ toolName: "mcp", content, structuredContent });

      expect(result).toStrictEqual({ content });
      expect(result).not.toHaveProperty("structuredContent");
    });
  });

  describe("bounded scanning", () => {
    it("scans adversarial 1 MiB output within a generous time bound", { timeout: 30_000 }, async () => {
      const { run } = setup();
      const urls = "postgres://a:".repeat(Math.floor(MiB / 13));
      const keys = "-----BEGIN RSA PRIVATE KEY-----\n".repeat(MiB / 32);

      const started = performance.now();
      const result = await run({
        toolName: "bash",
        content: [text(urls), text(keys)],
        structuredContent: { output: urls },
      });
      const elapsed = performance.now() - started;

      expect(result).toBeUndefined();
      expect(elapsed).toBeLessThan(5_000);
    });

    it("still redacts realistic URL credentials and PEM blocks", async () => {
      const { run } = setup();
      const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIJ${"A".repeat(12_000)}\n-----END RSA PRIVATE KEY-----`;
      const url = `mongodb+srv://svc:${"p".repeat(200)}@cluster0.example.net`;

      const result = await run({ toolName: "bash", content: [text(`${pem}\n${url}`)] });

      expect(result?.content).toStrictEqual([
        text("[PRIVATE_KEY_REDACTED]\nmongodb+srv://svc:[REDACTED]@cluster0.example.net"),
      ]);
    });
  });

  describe("sensitive file reads", () => {
    it.each([
      "credentials.ts",
      "/repo/credentials.test.ts",
      "/repo/credentials.http.test.ts",
      "/repo/credentials/index.ts",
      "/repo/my-credentials.test.ts",
      "C:\\repo\\credentials.ts",
      "C:\\repo\\credentials\\index.ts",
      "/repo/CREDENTIALS.test.ts",
    ])("keeps source readable and masks secret values in %s", async (path) => {
      const { run, notify } = setup();
      const source = "export const credentialCount = 2;";

      const clean = await run({
        toolName: "read",
        input: { path },
        content: [text(source)],
      });

      expect(clean).toBeUndefined();
      expect(notify).not.toHaveBeenCalled();

      const secret = await run({
        toolName: "read",
        input: { path },
        content: [text(`${source}\n// synthetic key: ${OPENAI_KEY}`)],
      });

      expect(secret).toStrictEqual({
        content: [text(`${source}\n// synthetic key: [OPENAI_KEY_REDACTED]`)],
      });
      expect(notify).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith(NOTICE, "info");
    });

    it.each([
      "credentials",
      "/home/synthetic/.aws/credentials",
      "/repo/credentials.json",
      "/repo/credentials.yaml",
      "/repo/credentials.yml",
      "/repo/credentials.toml",
      "/repo/credentials.ini",
      "C:\\synthetic\\.aws\\credentials",
      "C:\\repo\\CREDENTIALS.JSON",
      "/repo/CREDENTIALS.YAML",
    ])("replaces the whole contents of credential store %s", async (path) => {
      const { run } = setup();

      const result = await run({
        toolName: "read",
        input: { path },
        content: [text("synthetic store contents")],
      });

      expect(result).toStrictEqual({
        content: [text(`[Contents of ${path} redacted for security]`)],
      });
    });

    it("replaces the whole contents of a .env read", async () => {
      const { run, notify } = setup();

      const result = await run({
        toolName: "read",
        input: { path: "/repo/.env" },
        content: [text("FOO=bar")],
      });

      expect(result).toStrictEqual({
        content: [text("[Contents of /repo/.env redacted for security]")],
      });
      expect(notify).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith("🔒 Redacted contents of sensitive file: /repo/.env", "info");
    });

    it("sends an isError .env read through the regex path only", async () => {
      const { run } = setup();

      const secret = await run({
        toolName: "read",
        input: { path: "/repo/.env" },
        isError: true,
        content: [text(`EACCES reading /repo/.env: token=${PASSWORD}`)],
      });
      const clean = await run({
        toolName: "read",
        input: { path: "/repo/.env" },
        isError: true,
        content: [text("ENOENT: no such file /repo/.env")],
      });

      expect(secret).toStrictEqual({ content: [text("EACCES reading /repo/.env: token=[REDACTED]")] });
      expect(clean).toBeUndefined();
    });

    it("leaves .env.example alone", async () => {
      const { run } = setup();

      const result = await run({
        toolName: "read",
        input: { path: "/repo/.env.example" },
        content: [text("SECRET=changeme-please")],
      });

      expect(result).toBeUndefined();
    });
  });

  describe("no-op results", () => {
    it("returns undefined for clean output", async () => {
      const { run, notify } = setup();

      const result = await run({
        toolName: "bash",
        content: [text("hello")],
        structuredContent: { output: "hello", exit_code: 0 },
      });

      expect(result).toBeUndefined();
      expect(notify).not.toHaveBeenCalled();
    });

    it("returns undefined when content is missing", async () => {
      const { run } = setup();

      await expect(run({ toolName: "custom" })).resolves.toBeUndefined();
      await expect(run({ toolName: "custom", isError: true })).resolves.toBeUndefined();
    });
  });

  describe("notifications", () => {
    it("notifies once per top-level redacted result", async () => {
      const { run, notify } = setup();

      await run({
        toolName: "codemode",
        content: [text(`password=${PASSWORD}`), text(OPENAI_KEY)],
        structuredContent: { output: OPENAI_KEY },
      });

      expect(notify).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith(NOTICE, "info");
    });

    it("does not notify for nested calls", async () => {
      const { run, notify } = setup();
      const nested = { parentToolCallId: "call-0", toolCallId: "call-0/1" };

      const redacted = await run({ ...nested, toolName: "bash", content: [text(OPENAI_KEY)] });
      const file = await run({
        ...nested,
        toolName: "read",
        input: { path: "/repo/.env" },
        content: [text("FOO=bar")],
      });

      expect(redacted?.content).toStrictEqual([text("[OPENAI_KEY_REDACTED]")]);
      expect(file?.content).toStrictEqual([text("[Contents of /repo/.env redacted for security]")]);
      expect(notify).not.toHaveBeenCalled();
    });
  });
});
