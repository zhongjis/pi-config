import { describe, expect, it, vi } from "vitest";
import promptUrlWidgetExtension from "../src/prompt-url-widget.js";

type SessionEntry = {
  type: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  };
};

type EventHandler = (
  event: { prompt?: string },
  ctx: ReturnType<typeof createHarness>["ctx"],
) => unknown | Promise<unknown>;

type WidgetFactory = (
  tui: unknown,
  theme: { fg(color: string, text: string): string },
) => { children?: Array<{ text?: string }> };

const plainTheme = {
  fg: (_color: string, text: string) => text,
};

function createHarness(options: {
  hasUI?: boolean;
  initialName?: string;
  entries?: SessionEntry[];
  exec?: (...args: unknown[]) => Promise<unknown>;
} = {}) {
  const handlers = new Map<string, EventHandler>();
  const entries = options.entries ?? [];
  let sessionName = options.initialName;
  const setWidget = vi.fn();
  const setSessionName = vi.fn((name: string) => {
    sessionName = name;
  });
  const exec = vi.fn(options.exec ?? (async () => ({ code: 0, stdout: "{}" })));
  const pi = {
    on(event: string, handler: EventHandler): void {
      handlers.set(event, handler);
    },
    exec,
    getSessionName: vi.fn(() => sessionName),
    setSessionName,
  };
  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: { setWidget },
    sessionManager: {
      getEntries: () => entries,
    },
  };

  promptUrlWidgetExtension(pi as never);

  return {
    ctx,
    entries,
    exec,
    handlers,
    pi,
    setSessionName,
    setWidget,
    sessionName: () => sessionName,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function widgetText(setWidget: ReturnType<typeof vi.fn>, callIndex = -1): string {
  const call = setWidget.mock.calls.at(callIndex);
  expect(call?.[0]).toBe("prompt-url");
  expect(call?.[1]).toBeTypeOf("function");
  const component = (call?.[1] as WidgetFactory)({}, plainTheme);
  return component.children
    ?.map((child) => child.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n") ?? "";
}

describe("prompt-url widget characterization", () => {
  it("recognizes a PR prompt, installs prompt-url, then enriches its fallback session name", async () => {
    const url = "https://github.com/acme/app/pull/42";
    const harness = createHarness({
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify({
          title: "Ship QoL",
          author: { login: "ada", name: "Ada Lovelace" },
        }),
      }),
    });

    await harness.handlers.get("before_agent_start")?.(
      { prompt: `You are given one or more GitHub PR URLs:\n${url}` },
      harness.ctx,
    );
    await flushPromises();

    expect(harness.exec).toHaveBeenCalledWith(
      "gh",
      ["pr", "view", url, "--json", "title,author"],
    );
    expect(harness.setWidget.mock.calls.every(([key]) => key === "prompt-url"))
      .toBe(true);
    expect(widgetText(harness.setWidget)).toBe([
      "Ship QoL",
      "Ada Lovelace (@ada)",
      url,
    ].join("\n"));
    expect(harness.setSessionName.mock.calls.map(([name]) => name)).toEqual([
      `PR: ${url}`,
      `PR: Ship QoL (${url})`,
    ]);
    expect(harness.sessionName()).toBe(`PR: Ship QoL (${url})`);
  });

  it("recognizes an issue prompt and calls gh issue view with the exact URL", async () => {
    const url = "https://github.com/acme/app/issues/7";
    const harness = createHarness({
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify({
          title: "Fix launch failure",
          author: { login: "octo" },
        }),
      }),
    });

    await harness.handlers.get("before_agent_start")?.(
      { prompt: `Analyze GitHub issue(s): ${url}` },
      harness.ctx,
    );
    await flushPromises();

    expect(harness.exec).toHaveBeenCalledWith(
      "gh",
      ["issue", "view", url, "--json", "title,author"],
    );
    expect(widgetText(harness.setWidget)).toBe([
      "Fix launch failure",
      "@octo",
      url,
    ].join("\n"));
    expect(harness.sessionName()).toBe(`Issue: Fix launch failure (${url})`);
  });

  it("preserves a custom session name while still enriching the widget", async () => {
    const url = "https://github.com/acme/app/pull/9";
    const harness = createHarness({
      initialName: "Keep my investigation name",
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify({ title: "Do not rename this session" }),
      }),
    });

    await harness.handlers.get("before_agent_start")?.(
      { prompt: `You are given one or more GitHub PR URLs: ${url}` },
      harness.ctx,
    );
    await flushPromises();

    expect(harness.setSessionName).not.toHaveBeenCalled();
    expect(harness.sessionName()).toBe("Keep my investigation name");
    expect(widgetText(harness.setWidget)).toContain("Do not rename this session");
  });

  it("rebuilds from the latest matching user entry and clears on a session without one", async () => {
    const url = "https://github.com/acme/app/issues/11";
    const entries: SessionEntry[] = [
      {
        type: "message",
        message: { role: "assistant", content: "Analyze GitHub issue(s): ignored" },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "unrelated prefix" },
            { type: "text", text: `Analyze GitHub issue(s): ${url}` },
          ],
        },
      },
    ];
    const harness = createHarness({
      entries,
      exec: async () => ({ code: 1, stdout: "" }),
    });

    await harness.handlers.get("session_start")?.({}, harness.ctx);
    await flushPromises();

    expect(widgetText(harness.setWidget)).toContain(url);
    expect(harness.exec).toHaveBeenCalledWith(
      "gh",
      ["issue", "view", url, "--json", "title,author"],
    );

    entries.splice(0, entries.length, {
      type: "message",
      message: { role: "user", content: "ordinary prompt" },
    });
    await harness.handlers.get("session_switch")?.({}, harness.ctx);

    expect(harness.setWidget).toHaveBeenLastCalledWith("prompt-url", undefined);
  });

  it("does nothing and does not throw for recognized prompts or session rebuilds without UI", async () => {
    const harness = createHarness({
      hasUI: false,
      entries: [{
        type: "message",
        message: {
          role: "user",
          content: "Analyze GitHub issue(s): https://github.com/acme/app/issues/12",
        },
      }],
    });

    await expect(harness.handlers.get("before_agent_start")?.(
      { prompt: "You are given one or more GitHub PR URLs: https://github.com/acme/app/pull/12" },
      harness.ctx,
    )).resolves.toBeUndefined();
    await expect(harness.handlers.get("session_start")?.({}, harness.ctx))
      .resolves.toBeUndefined();
    await expect(harness.handlers.get("session_switch")?.({}, harness.ctx))
      .resolves.toBeUndefined();

    expect(harness.exec).not.toHaveBeenCalled();
    expect(harness.setWidget).not.toHaveBeenCalled();
    expect(harness.setSessionName).not.toHaveBeenCalled();
  });

  it("keeps fallback widget and session naming when gh metadata lookup fails", async () => {
    const url = "https://github.com/acme/app/pull/13";
    const harness = createHarness({
      exec: async () => {
        throw new Error("gh unavailable");
      },
    });

    await expect(harness.handlers.get("before_agent_start")?.(
      { prompt: `You are given one or more GitHub PR URLs: ${url}` },
      harness.ctx,
    )).resolves.toBeUndefined();
    await flushPromises();

    expect(widgetText(harness.setWidget)).toBe([url, url].join("\n"));
    expect(harness.sessionName()).toBe(`PR: ${url}`);
  });
});
