import { describe, expect, it } from "vitest";
import {
  parseHunkComments,
  parseHttpComments,
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
// Captured verbatim from the hunk 0.17.1 daemon: an --agent-context annotation
// surfaces as source "ai"; a live HTTP comment-list response for a user note.
const NEW_AI =
  '{"comments":[{"noteId":"ai:/repo:0:file.txt:0","source":"ai","filePath":"file.txt","newRange":[2,2],"body":"agent note here\\n\\nwhy it matters","createdAt":"1970-01-01T00:00:00.000Z","editable":false}]}';
const HTTP_USER =
  '{"comments":[{"noteId":"user:1784341126395","source":"user","filePath":"f.txt","hunkIndex":0,"newRange":[2,2],"body":"HTTP PROBE NOTE","author":"user","createdAt":"2026-07-18T02:18:46.395Z","editable":true}]}';
const HTTP_ERROR = '{"error":"Unknown session API action."}';

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
  it("keeps user + legacy (null) and drops agent/ai", () => {
    const user: HunkComment = { file: "a", line: 1, summary: "u", source: "user" };
    const agent: HunkComment = { file: "b", line: 2, summary: "a", source: "agent" };
    const ai: HunkComment = { file: "d", line: 4, summary: "ai", source: "ai" };
    const legacy: HunkComment = { file: "c", line: 3, summary: "l", source: null };
    expect(keepUserAuthored([user, agent, ai, legacy])).toEqual([user, legacy]);
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

describe("parseHunkComments (agent-context annotation)", () => {
  it("parses the new schema (source=ai) so keepUserAuthored can drop it", () => {
    expect(parseHunkComments(NEW_AI)).toEqual([
      { file: "file.txt", line: 2, summary: "agent note here\n\nwhy it matters", source: "ai" },
    ]);
  });
});

describe("parseHttpComments", () => {
  it("parses a real daemon HTTP comment-list payload (source=user)", () => {
    expect(parseHttpComments(HTTP_USER)).toEqual([
      { file: "f.txt", line: 2, summary: "HTTP PROBE NOTE", source: "user" },
    ]);
  });

  it("returns [] for a valid empty payload (success-empty)", () => {
    expect(parseHttpComments('{"comments":[]}')).toEqual([]);
  });

  it("returns null for a daemon error response (drift-safe, must not wipe)", () => {
    expect(parseHttpComments(HTTP_ERROR)).toBeNull();
  });

  it("returns null for a non-comments object shape", () => {
    expect(parseHttpComments('{"sessions":[]}')).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseHttpComments("not json{")).toBeNull();
  });
});
