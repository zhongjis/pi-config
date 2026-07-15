import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";

describe("ConversationViewer stop (x key)", () => {
  function makeViewer(status: string, onStop?: () => void) {
    const tui = { requestRender: () => {}, terminal: { rows: 40 } } as any;
    const session = { subscribe: () => () => {}, messages: [] } as any;
    const record = { id: "a1", type: "general-purpose", status, description: "d", startedAt: 0 } as any;
    return new ConversationViewer(tui, session, record, undefined, {} as any, () => {}, onStop);
  }

  it("first x arms, second x calls onStop when running", () => {
    let stopped = 0;
    const v = makeViewer("running", () => { stopped++; });
    v.handleInput("x");
    expect(stopped).toBe(0);
    v.handleInput("x");
    expect(stopped).toBe(1);
  });

  it("any other key disarms", () => {
    let stopped = 0;
    const v = makeViewer("running", () => { stopped++; });
    v.handleInput("x");      // arm
    v.handleInput("j");      // disarm (scroll)
    v.handleInput("x");      // arm again, not confirm
    expect(stopped).toBe(0);
  });

  it("x is inert when not stoppable or onStop missing", () => {
    let stopped = 0;
    const completed = makeViewer("completed", () => { stopped++; });
    completed.handleInput("x");
    completed.handleInput("x");
    expect(stopped).toBe(0);
  });
});

describe("ConversationViewer render coalescing", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("coalesces a burst of session events into one render per cadence", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn();
    let sessionCb: (() => void) | undefined;
    const tui = { requestRender, terminal: { rows: 40, columns: 80 } } as any;
    const session = {
      messages: [] as any[],
      subscribe: (cb: () => void) => { sessionCb = cb; return () => {}; },
    } as any;
    const record = { id: "a1", type: "general-purpose", status: "running", description: "d", startedAt: 0 } as any;
    new ConversationViewer(tui, session, record, undefined, {} as any, () => {});

    expect(sessionCb).toBeDefined();
    for (let i = 0; i < 13; i++) sessionCb!();
    expect(requestRender).not.toHaveBeenCalled();

    vi.advanceTimersByTime(99);
    expect(requestRender).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });
});

describe("ConversationViewer content caching", () => {
  function makeViewer(messages: any[], rows = 40) {
    const tui = { requestRender: () => {}, terminal: { rows, columns: 80 } } as any;
    const session = { subscribe: () => () => {}, messages } as any;
    const record = { id: "a1", type: "general-purpose", status: "completed", description: "d", startedAt: 0 } as any;
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;
    return new ConversationViewer(tui, session, record, undefined, theme, () => {});
  }

  it("returns the same cached array for identical width + messages", () => {
    const v: any = makeViewer([{ role: "user", content: "hello" }]);
    const a = v.getContentLines(80);
    const b = v.getContentLines(80);
    expect(b).toBe(a);
  });

  it("rebuilds after invalidate()", () => {
    const v: any = makeViewer([{ role: "user", content: "hello" }]);
    const a = v.getContentLines(80);
    v.invalidate();
    const b = v.getContentLines(80);
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
  });

  it("rebuilds when width changes", () => {
    const v: any = makeViewer([{ role: "user", content: "hello" }]);
    const a = v.getContentLines(80);
    const b = v.getContentLines(70);
    expect(b).not.toBe(a);
  });

  it("rebuilds when a new message is appended", () => {
    const messages: any[] = [{ role: "user", content: "hello" }];
    const v: any = makeViewer(messages);
    const a = v.getContentLines(80);
    messages.push({ role: "assistant", content: [{ type: "text", text: "hi" }] });
    const b = v.getContentLines(80);
    expect(b).not.toBe(a);
  });
});
