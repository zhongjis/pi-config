import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { installFooterVisuals } from "../src/footer.js";

const QUEUE_STEER_PENDING_WORK_KEY = Symbol.for("pi-queue-steer:pending-work");

function setQueuePendingWork(hasPendingWork: () => boolean): void {
  (globalThis as Record<symbol, unknown>)[QUEUE_STEER_PENDING_WORK_KEY] = Object.freeze({ hasPendingWork });
}

function createContextUsage(
  tokens: number | null,
  contextWindow = 272_000,
) {
  const compact = vi.fn();
  const ctx = {
    ...createMockContext(),
    compact,
    getContextUsage: () => ({
      contextWindow,
      percent: tokens === null ? null : (tokens / contextWindow) * 100,
      tokens,
    }),
  };
  return { compact, ctx };
}

describe("QOL context compaction guard", () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[QUEUE_STEER_PENDING_WORK_KEY];
  });
  it("compacts immediately after the agent settles over the model context limit", async () => {
    const mock = createMockPi();
    installFooterVisuals(mock.pi as never);
    const { compact, ctx } = createContextUsage(319_328);

    await mock.fireLifecycle("agent_settled", {}, ctx);

    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("does not compact while Pi has native pending messages", async () => {
    const mock = createMockPi();
    installFooterVisuals(mock.pi as never);
    const { compact, ctx } = createContextUsage(319_328);
    ctx.hasPendingMessages = () => true;

    await mock.fireLifecycle("agent_settled", {}, ctx);

    expect(compact).not.toHaveBeenCalled();
  });

  it("does not compact over-limit context while queue-steer has a queued row", async () => {
    const mock = createMockPi();
    installFooterVisuals(mock.pi as never);
    const { compact, ctx } = createContextUsage(319_328);
    setQueuePendingWork(() => true);

    await mock.fireLifecycle("agent_settled", {}, ctx);

    expect(compact).not.toHaveBeenCalled();
  });

  it("does not compact after queue-steer releases a continuation awaiting agent_start", async () => {
    const mock = createMockPi();
    installFooterVisuals(mock.pi as never);
    const { compact, ctx } = createContextUsage(319_328);
    let releasePending = true;
    setQueuePendingWork(() => releasePending);

    await mock.fireLifecycle("agent_settled", {}, ctx);
    releasePending = false;
    await mock.fireLifecycle("agent_settled", {}, ctx);

    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("does not compact at or below the model context limit", async () => {
    const mock = createMockPi();
    installFooterVisuals(mock.pi as never);
    const atLimit = createContextUsage(272_000);
    const belowLimit = createContextUsage(271_999);

    await mock.fireLifecycle("agent_settled", {}, atLimit.ctx);
    await mock.fireLifecycle("agent_settled", {}, belowLimit.ctx);

    expect(atLimit.compact).not.toHaveBeenCalled();
    expect(belowLimit.compact).not.toHaveBeenCalled();
  });

  it("ignores unavailable context usage", async () => {
    const mock = createMockPi();
    installFooterVisuals(mock.pi as never);
    const { compact, ctx } = createContextUsage(null);

    await mock.fireLifecycle("agent_settled", {}, ctx);

    expect(compact).not.toHaveBeenCalled();
  });

  it("does not start a second compaction while the first is pending", async () => {
    const mock = createMockPi();
    installFooterVisuals(mock.pi as never);
    const { compact, ctx } = createContextUsage(319_328);
    let onComplete: (() => void) | undefined;
    compact.mockImplementation((options) => {
      onComplete = options.onComplete;
    });

    await mock.fireLifecycle("agent_settled", {}, ctx);
    await mock.fireLifecycle("agent_settled", {}, ctx);

    expect(compact).toHaveBeenCalledTimes(1);
    onComplete?.();
    await mock.fireLifecycle("agent_settled", {}, ctx);
    expect(compact).toHaveBeenCalledTimes(2);
  });
});
