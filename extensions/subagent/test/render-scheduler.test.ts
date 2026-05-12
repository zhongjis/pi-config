import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderScheduler } from "../src/ui/render-scheduler.js";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("RenderScheduler", () => {
  it("coalesces same-tick render requests into one cadence flush", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const scheduler = new RenderScheduler(flush, 250);

    for (let i = 0; i < 13; i++) {
      scheduler.requestRender();
    }

    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(249);
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("flushes immediately and clears a pending delayed flush", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const scheduler = new RenderScheduler(flush, 250);

    scheduler.requestRender();
    scheduler.flushNow();

    expect(flush).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(250);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("dispose clears pending delayed flush", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const scheduler = new RenderScheduler(flush, 250);

    scheduler.requestRender();
    scheduler.dispose();

    vi.advanceTimersByTime(250);
    expect(flush).not.toHaveBeenCalled();
  });
});
