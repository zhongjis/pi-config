import { describe, expect, it } from "vitest";
import { LOCAL_URI_SUBAGENT_HINT, localUriHint } from "../src/local-uri-hint.js";

describe("localUriHint", () => {
  it("returns the hint when a source references a local:// path", () => {
    expect(localUriHint("read the plan at local://plan.md")).toBe(LOCAL_URI_SUBAGENT_HINT);
  });

  it("returns empty string when no source references local://", () => {
    expect(localUriHint("read ./plan.md and run tests")).toBe("");
  });

  it("ignores undefined sources and checks the rest", () => {
    expect(localUriHint(undefined, "use local://notes.txt")).toBe(LOCAL_URI_SUBAGENT_HINT);
    expect(localUriHint(undefined, "no scheme here")).toBe("");
  });

  it("hint mentions session scoping and stays non-blocking", () => {
    expect(LOCAL_URI_SUBAGENT_HINT).toContain("session-scoped");
    expect(LOCAL_URI_SUBAGENT_HINT).toContain("current session");
    expect(LOCAL_URI_SUBAGENT_HINT).toContain("ignore if it should write its own");
  });
});
