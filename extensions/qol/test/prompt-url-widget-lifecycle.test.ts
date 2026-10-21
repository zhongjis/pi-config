import { describe, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import promptUrlWidgetExtension from "../src/prompt-url-widget.js";

const url = "https://github.com/acme/app/issues/7";
const prompt = `Analyze GitHub issue(s): ${url}`;

describe("prompt-url widget lifecycle", () => {
  it("names RPC sessions without installing component factories", async () => {
    const mock = createMockPi();
    const setWidget = vi.fn();
    const setSessionName = vi.fn();
    promptUrlWidgetExtension({
      ...mock.pi,
      exec: async () => ({ code: 0, stdout: '{"title":"Issue title"}' }),
      getSessionName: () => undefined,
      setSessionName,
    } as never);
    const ctx = { ...createMockContext(), mode: "rpc", ui: { setWidget } };

    await mock.fireLifecycle("before_agent_start", { prompt }, ctx);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(setWidget).not.toHaveBeenCalled();
    expect(setSessionName).toHaveBeenLastCalledWith(`Issue: Issue title (${url})`);
  });

  it.each(["before_agent_start", "session_start"])("settles metadata safely after %s loses its context", async (event) => {
    const mock = createMockPi();
    let resolveMetadata: (value: { code: number; stdout: string }) => void = () => {};
    const metadata = new Promise<{ code: number; stdout: string }>(resolve => {
      resolveMetadata = resolve;
    });
    const setWidget = vi.fn();
    const setSessionName = vi.fn();
    promptUrlWidgetExtension({
      ...mock.pi,
      exec: () => metadata,
      getSessionName: () => undefined,
      setSessionName,
    } as never);
    const ctx = {
      ...createMockContext(),
      mode: "tui",
      ui: { setWidget },
      sessionManager: { getEntries: () => [{ type: "message", message: { role: "user", content: prompt } }] },
    };
    await mock.fireLifecycle(event, { prompt }, ctx);
    setWidget.mockImplementation(() => { throw new Error("Extension context is no longer active"); });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      resolveMetadata({ code: 0, stdout: '{"title":"Late metadata"}' });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(setSessionName).toHaveBeenCalledTimes(1);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("ignores metadata that arrives after shutdown", async () => {
    const mock = createMockPi();
    let resolveMetadata: (value: { code: number; stdout: string }) => void = () => {};
    const metadata = new Promise<{ code: number; stdout: string }>(resolve => { resolveMetadata = resolve; });
    const setWidget = vi.fn();
    const setSessionName = vi.fn();
    promptUrlWidgetExtension({ ...mock.pi, exec: () => metadata, getSessionName: () => undefined, setSessionName } as never);
    const ctx = { ...createMockContext(), mode: "tui", ui: { setWidget } };
    await mock.fireLifecycle("before_agent_start", { prompt }, ctx);
    await mock.fireLifecycle("session_shutdown", {}, ctx);

    resolveMetadata({ code: 0, stdout: '{"title":"Late metadata"}' });
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(setWidget).toHaveBeenCalledTimes(1);
    expect(setSessionName).toHaveBeenCalledTimes(1);
  });
});
