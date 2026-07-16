import { describe, expect, it } from "vitest";
import {
  parseHunkComments,
  keepUserAuthored,
  mergeSnapshot,
  formatReviewPrompt,
  type HunkComment,
} from "./index.js";

// Fixtures captured verbatim from hunk 0.17.0.
const NEW_USER =
  '{"comments":[{"noteId":"mcp:abc","source":"user","filePath":"file.txt","hunkIndex":0,"newRange":[4,4],"body":"Fix this wording","author":"me","createdAt":"2026-07-15T19:58:11.876Z","editable":true}]}';
const NEW_AGENT =
  '{"comments":[{"noteId":"mcp:abc","source":"agent","filePath":"file.txt","hunkIndex":0,"newRange":[4,4],"body":"Fix this wording","author":"me","createdAt":"2026-07-15T19:58:11.876Z","editable":true}]}';
const LEGACY =
  '{"comments":[{"commentId":"mcp:abc","filePath":"file.txt","hunkIndex":0,"side":"new","line":4,"summary":"Fix this wording","author":"user","createdAt":"2026-07-15T19:58:11.876Z"}]}';
const LEGACY_BARE_ARRAY =
  '[{"commentId":"mcp:abc","filePath":"file.txt","hunkIndex":0,"side":"new","line":4,"summary":"Fix this wording","author":"user","createdAt":"2026-07-15T19:58:11.876Z"}]';

describe("parseHunkComments", () => {
  it("parses the new schema (source=user)", () => {
    expect(parseHunkComments(NEW_USER)).toEqual([
      { file: "file.txt", line: 4, summary: "Fix this wording", source: "user" },
    ]);
  });

  it("parses the legacy schema (no source)", () => {
    expect(parseHunkComments(LEGACY)).toEqual([
      { file: "file.txt", line: 4, summary: "Fix this wording", source: null },
    ]);
  });

  it("preserves source=agent (does not filter)", () => {
    expect(parseHunkComments(NEW_AGENT)).toEqual([
      { file: "file.txt", line: 4, summary: "Fix this wording", source: "agent" },
    ]);
  });

  it("returns [] for valid JSON with no comments", () => {
    expect(parseHunkComments('{"comments":[]}')).toEqual([]);
  });

  it("parses a bare-array legacy payload", () => {
    expect(parseHunkComments(LEGACY_BARE_ARRAY)).toEqual([
      { file: "file.txt", line: 4, summary: "Fix this wording", source: null },
    ]);
  });

  it("returns null for invalid JSON", () => {
    expect(parseHunkComments("not json{")).toBeNull();
  });

  it("filters out entries with empty body/summary", () => {
    const stdout =
      '{"comments":[{"noteId":"x","source":"user","filePath":"file.txt","newRange":[4,4],"body":"   "}]}';
    expect(parseHunkComments(stdout)).toEqual([]);
  });
});

describe("keepUserAuthored", () => {
  it("keeps user + legacy (null) and drops agent", () => {
    const user: HunkComment = { file: "a", line: 1, summary: "u", source: "user" };
    const agent: HunkComment = { file: "b", line: 2, summary: "a", source: "agent" };
    const legacy: HunkComment = { file: "c", line: 3, summary: "l", source: null };
    expect(keepUserAuthored([user, agent, legacy])).toEqual([user, legacy]);
  });
});

describe("mergeSnapshot", () => {
  const c: HunkComment = { file: "file.txt", line: 4, summary: "Fix this", source: "user" };

  it("keeps prev when next is null (failed poll)", () => {
    expect(mergeSnapshot([c], null)).toEqual([c]);
  });

  it("replaces prev with empty next (success-empty)", () => {
    expect(mergeSnapshot([c], [])).toEqual([]);
  });

  it("adopts next when prev is null", () => {
    expect(mergeSnapshot(null, [c])).toEqual([c]);
  });
});

describe("formatReviewPrompt", () => {
  it("includes the header and a file:line — summary line", () => {
    const prompt = formatReviewPrompt([
      { file: "file.txt", line: 4, summary: "Fix this", source: "user" },
    ]);
    expect(prompt).toContain(
      "Address the following code comments in the code:",
    );
    expect(prompt).toContain("- file.txt:4 — Fix this");
  });
});
