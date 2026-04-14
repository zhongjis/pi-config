import { describe, expect, it, vi } from "vitest";
import { debounce, checkExec, notifyError, requireUI, safeModel, safeUsage } from "../utils.js";
import { createMockContext } from "../../../test/fixtures/mock-context.js";

// ---------------------------------------------------------------------------
// debounce
// ---------------------------------------------------------------------------

describe("debounce", () => {
  it("delays invocation by ms", async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  it("resets the timer on repeated calls", async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(50);
    debounced();
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  it("cancel() prevents pending invocation", async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    debounced.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// checkExec
// ---------------------------------------------------------------------------

describe("checkExec", () => {
  it("returns ok: true when code is 0 and not killed", () => {
    const result = checkExec({ code: 0, stdout: "output", stderr: "", killed: false });
    expect(result).toEqual({ ok: true, stdout: "output", stderr: "" });
  });

  it("returns ok: false when code is non-zero", () => {
    const result = checkExec({ code: 1, stdout: "", stderr: "err", killed: false });
    expect(result).toEqual({ ok: false, stdout: "", stderr: "err" });
  });

  it("returns ok: false when killed even if code is 0", () => {
    const result = checkExec({ code: 0, stdout: "", stderr: "", killed: true });
    expect(result.ok).toBe(false);
  });

  it("returns ok: false when code is null", () => {
    const result = checkExec({ code: null, stdout: "", stderr: "", killed: false });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// notifyError
// ---------------------------------------------------------------------------

describe("notifyError", () => {
  it("calls ctx.ui.notify with error level when hasUI is true", () => {
    const ctx = createMockContext();
    const notifySpy = vi.spyOn(ctx.ui, "notify");

    notifyError(ctx, new Error("boom"), "label");
    expect(notifySpy).toHaveBeenCalledWith("label: boom", "error");
  });

  it("handles non-Error values", () => {
    const ctx = createMockContext();
    const notifySpy = vi.spyOn(ctx.ui, "notify");

    notifyError(ctx, "raw string error", "");
    expect(notifySpy).toHaveBeenCalledWith("raw string error", "error");
  });

  it("falls back to console.error when hasUI is false", () => {
    const ctx = { ...createMockContext(), hasUI: false };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    notifyError(ctx, new Error("oops"), "ctx");
    expect(consoleSpy).toHaveBeenCalledWith("ctx: oops");

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// requireUI / safeModel / safeUsage
// ---------------------------------------------------------------------------

describe("requireUI", () => {
  it("returns ctx.hasUI", () => {
    const ctx = createMockContext();
    expect(requireUI(ctx)).toBe(true);
    expect(requireUI({ ...ctx, hasUI: false })).toBe(false);
  });
});

describe("safeModel", () => {
  it("returns ctx.model when present", () => {
    const ctx = createMockContext();
    expect(safeModel(ctx)).toEqual({ id: "mock-model", provider: "mock" });
  });

  it("returns null when model is undefined", () => {
    const ctx = { ...createMockContext(), model: undefined };
    expect(safeModel(ctx)).toBeNull();
  });
});

describe("safeUsage", () => {
  it("returns context usage when available", () => {
    const ctx = createMockContext();
    expect(safeUsage(ctx)).toEqual({ contextWindow: 200_000, percent: 0, tokens: 0 });
  });

  it("returns null when getContextUsage throws", () => {
    const ctx = {
      ...createMockContext(),
      getContextUsage: () => { throw new Error("unavailable"); },
    };
    expect(safeUsage(ctx)).toBeNull();
  });
});
