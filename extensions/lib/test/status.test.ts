import { describe, expect, it, vi } from "vitest";
import { withStatus, buildStatusLine } from "../status.js";
import { createMockContext } from "../../../test/fixtures/mock-context.js";

// ---------------------------------------------------------------------------
// withStatus
// ---------------------------------------------------------------------------

describe("withStatus", () => {
  it("sets status before fn runs and clears after", async () => {
    const ctx = createMockContext();
    const setStatusSpy = vi.spyOn(ctx.ui, "setStatus");

    await withStatus(ctx, "test-key", "working…", async () => {
      expect(setStatusSpy).toHaveBeenCalledWith("test-key", "working…");
    });

    expect(setStatusSpy).toHaveBeenLastCalledWith("test-key", undefined);
  });

  it("clears status even when fn throws", async () => {
    const ctx = createMockContext();
    const setStatusSpy = vi.spyOn(ctx.ui, "setStatus");

    await expect(
      withStatus(ctx, "key", "busy", async () => {
        throw new Error("oh no");
      })
    ).rejects.toThrow("oh no");

    expect(setStatusSpy).toHaveBeenLastCalledWith("key", undefined);
  });

  it("still calls fn when hasUI is false", async () => {
    const ctx = { ...createMockContext(), hasUI: false };
    const fn = vi.fn(async () => "result");

    const result = await withStatus(ctx, "k", "text", fn);
    expect(fn).toHaveBeenCalledOnce();
    expect(result).toBe("result");
  });

  it("returns fn's return value", async () => {
    const ctx = createMockContext();
    const result = await withStatus(ctx, "k", "text", async () => 42);
    expect(result).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// buildStatusLine
// ---------------------------------------------------------------------------

describe("buildStatusLine", () => {
  it("joins parts with default separator", () => {
    const ctx = createMockContext();
    const theme = ctx.ui.theme;

    const result = buildStatusLine(theme, [
      { text: "part1" },
      { text: "part2" },
    ]);
    expect(result).toBe("part1 · part2");
  });

  it("applies custom separator", () => {
    const ctx = createMockContext();
    const result = buildStatusLine(ctx.ui.theme, [
      { text: "a" },
      { text: "b" },
    ], undefined, " | ");
    expect(result).toBe("a | b");
  });

  it("truncates to maxWidth", () => {
    const ctx = createMockContext();
    const result = buildStatusLine(ctx.ui.theme, [
      { text: "hello world" },
    ], 5);
    expect(result).toBe("hello");
  });

  it("passes text through mock theme unchanged", () => {
    const ctx = createMockContext();
    const result = buildStatusLine(ctx.ui.theme, [
      { text: "colored", color: "warning" },
      { text: "bold text", bold: true },
    ]);
    // Mock theme passes text through unchanged
    expect(result).toBe("colored · bold text");
  });

  it("handles empty parts array", () => {
    const ctx = createMockContext();
    const result = buildStatusLine(ctx.ui.theme, []);
    expect(result).toBe("");
  });
});
