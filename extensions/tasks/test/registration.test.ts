import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

function mockPi() {
  const tools = new Set<string>();
  const channels = new Set<string>();
  const pi = {
    registerTool(def: { name: string }) { tools.add(def.name); },
    registerCommand: vi.fn(),
    on: vi.fn(),
    events: {
      on(channel: string) { channels.add(channel); return () => {}; },
      emit(channel: string) { channels.add(channel); },
    },
  };
  return { pi, tools, channels };
}

describe("task extension registration", () => {
  it("registers process-only task tools without subagent channels", () => {
    const mock = mockPi();
    initExtension(mock.pi as never);

    expect([...mock.tools].sort()).toEqual([
      "TaskCreate",
      "TaskGet",
      "TaskList",
      "TaskOutput",
      "TaskStop",
      "TaskUpdate",
    ]);
    expect([...mock.channels].filter(channel => channel.startsWith("subagents:"))).toEqual([]);
  });
});
