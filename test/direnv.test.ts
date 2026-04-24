import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "./fixtures/mock-context.js";
import { createMockPi } from "./fixtures/mock-pi.js";

const mockState = vi.hoisted(() => ({
  execCallbacks: [] as Array<
    (error: Error | null, stdout: string, stderr: string) => void
  >,
  execCalls: [] as string[],
  watchCallbacks: [] as Array<() => void>,
  watcherCloses: [] as ReturnType<typeof vi.fn>[],
}));

vi.mock("node:child_process", () => ({
  exec: vi.fn(
    (
      _command: string,
      options: { cwd?: string },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      mockState.execCalls.push(String(options.cwd ?? ""));
      mockState.execCallbacks.push(callback);
    },
  ),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");

  return {
    ...actual,
    watch: vi.fn((_path: string, callback: () => void) => {
      mockState.watchCallbacks.push(callback);
      const close = vi.fn();
      mockState.watcherCloses.push(close);
      return { close };
    }),
  };
});

import initDirenv from "../extensions/direnv.js";

function createSessionContext(cwd: string) {
  let stale = false;
  const base = createMockContext();
  const notify = vi.fn();
  const setStatus = vi.fn();

  return {
    ctx: {
      ...base,
      get cwd() {
        if (stale) throw new Error(`stale ctx ${cwd}`);
        return cwd;
      },
      ui: {
        ...base.ui,
        notify,
        setStatus,
      },
    },
    markStale() {
      stale = true;
    },
    notify,
    setStatus,
  };
}

describe("direnv", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockState.execCallbacks.length = 0;
    mockState.execCalls.length = 0;
    mockState.watchCallbacks.length = 0;
    mockState.watcherCloses.length = 0;
    delete process.env.DIRENV_NEW;
    delete process.env.DIRENV_OLD;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DIRENV_NEW;
    delete process.env.DIRENV_OLD;
  });

  it("cancels pending debounced reloads when tree navigation rebinds session ctx", async () => {
    const mock = createMockPi();
    initDirenv(mock.pi as never);

    const first = createSessionContext("/repo/one");
    const second = createSessionContext("/repo/two");

    await mock.fireLifecycle("session_start", {}, first.ctx);
    expect(mockState.execCalls).toEqual(["/repo/one"]);
    expect(mockState.watchCallbacks).toHaveLength(2);

    mockState.watchCallbacks[0]?.();
    first.markStale();

    await mock.fireLifecycle("session_tree", {}, second.ctx);

    expect(mockState.execCalls).toEqual(["/repo/one", "/repo/two"]);
    expect(mockState.watcherCloses[0]).toHaveBeenCalledTimes(1);
    expect(mockState.watcherCloses[1]).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300);

    expect(mockState.execCalls).toEqual(["/repo/one", "/repo/two"]);
  });

  it("ignores in-flight exec callbacks from replaced sessions", async () => {
    const mock = createMockPi();
    initDirenv(mock.pi as never);

    const first = createSessionContext("/repo/one");
    const second = createSessionContext("/repo/two");

    await mock.fireLifecycle("session_start", {}, first.ctx);
    expect(mockState.execCalls).toEqual(["/repo/one"]);

    const oldCallback = mockState.execCallbacks[0];
    expect(oldCallback).toBeDefined();

    first.markStale();
    await mock.fireLifecycle("session_switch", { reason: "new" }, second.ctx);
    expect(mockState.execCalls).toEqual(["/repo/one", "/repo/two"]);

    expect(() => oldCallback?.(null, '{"DIRENV_OLD":"1"}', "")).not.toThrow();
    expect(process.env.DIRENV_OLD).toBeUndefined();
    expect(first.setStatus).not.toHaveBeenCalled();

    const newCallback = mockState.execCallbacks[1];
    expect(newCallback).toBeDefined();
    newCallback?.(null, '{"DIRENV_NEW":"1"}', "");

    expect(process.env.DIRENV_NEW).toBe("1");
  });
});
