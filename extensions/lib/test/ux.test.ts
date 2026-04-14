import { describe, expect, it } from "vitest";
import { confirmOrAbort, selectOrAbort, withSpinner } from "../ux.js";
import { createMockContext } from "../../../test/fixtures/mock-context.js";

vi.mock("@mariozechner/pi-coding-agent", () => import("../../../test/stubs/pi-coding-agent.js"));

// ---------------------------------------------------------------------------
// confirmOrAbort
// ---------------------------------------------------------------------------

describe("confirmOrAbort", () => {
  it("returns false when hasUI is false", async () => {
    const ctx = { ...createMockContext(), hasUI: false };
    const result = await confirmOrAbort(ctx, "title", "question?");
    expect(result).toBe(false);
  });

  it("returns true when ui.confirm resolves true", async () => {
    const ctx = createMockContext();
    (ctx.ui as any).confirm = async () => true;

    const result = await confirmOrAbort(ctx, "title", "question?");
    expect(result).toBe(true);
  });

  it("returns false when ui.confirm resolves undefined (cancelled)", async () => {
    const ctx = createMockContext();
    (ctx.ui as any).confirm = async () => undefined;

    const result = await confirmOrAbort(ctx, "title", "question?");
    expect(result).toBe(false);
  });

  it("returns false when ui.confirm throws", async () => {
    const ctx = createMockContext();
    (ctx.ui as any).confirm = async () => { throw new Error("cancelled"); };

    const result = await confirmOrAbort(ctx, "title", "question?");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// selectOrAbort
// ---------------------------------------------------------------------------

describe("selectOrAbort", () => {
  it("returns null when hasUI is false", async () => {
    const ctx = { ...createMockContext(), hasUI: false };
    const result = await selectOrAbort(ctx, "title", ["a", "b"]);
    expect(result).toBeNull();
  });

  it("returns selected string when ui.select resolves", async () => {
    const ctx = createMockContext();
    (ctx.ui as any).select = async (_title: string, _items: string[]) => "b";

    const result = await selectOrAbort(ctx, "pick", ["a", "b"]);
    expect(result).toBe("b");
  });

  it("returns null when ui.select resolves undefined", async () => {
    const ctx = createMockContext();
    (ctx.ui as any).select = async () => undefined;

    const result = await selectOrAbort(ctx, "pick", ["a"]);
    expect(result).toBeNull();
  });

  it("returns null when ui.select throws", async () => {
    const ctx = createMockContext();
    (ctx.ui as any).select = async () => { throw new Error("escaped"); };

    const result = await selectOrAbort(ctx, "pick", ["a"]);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// withSpinner
// ---------------------------------------------------------------------------

describe("withSpinner", () => {
  it("sets status while fn runs and clears after", async () => {
    const ctx = createMockContext();
    const setStatusSpy = vi.spyOn(ctx.ui, "setStatus");

    await withSpinner(ctx, "key", "loading…", async () => {
      expect(setStatusSpy).toHaveBeenCalledWith("key", "loading…");
    });

    expect(setStatusSpy).toHaveBeenLastCalledWith("key", undefined);
  });

  it("returns fn return value", async () => {
    const ctx = createMockContext();
    const result = await withSpinner(ctx, "k", "label", async () => 99);
    expect(result).toBe(99);
  });
});
