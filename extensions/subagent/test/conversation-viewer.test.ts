import { describe, expect, it } from "vitest";
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
