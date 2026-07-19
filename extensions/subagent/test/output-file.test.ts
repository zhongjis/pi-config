import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeCwd, streamToOutputFile, writeInitialEntry } from "../src/output-file.js";


type TestMessage = { role: string; content: string };
type TestEvent = { type: string; aborted?: boolean; result?: unknown; reason?: string };

type StreamTestSession = Parameters<typeof streamToOutputFile>[0] & {
  messages: TestMessage[];
  emit: (event: TestEvent) => void;
};

function createSession(messages: TestMessage[]): StreamTestSession {
  const listeners = new Set<(event: TestEvent) => void>();
  return {
    messages,
    subscribe(listener: (event: TestEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event: TestEvent) {
      for (const listener of listeners) listener(event);
    },
  } as StreamTestSession;
}

const tempDirs = new Set<string>();

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function outputPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-output-file-test-"));
  tempDirs.add(dir);
  return join(dir, "agent.output");
}

function readRows(path: string): Array<{ type: string; message: TestMessage }> {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
describe("encodeCwd", () => {
  it("encodes a POSIX absolute path by stripping the leading slash and replacing separators", () => {
    expect(encodeCwd("/home/user/project")).toBe("home-user-project");
  });

  it("handles a POSIX root path", () => {
    expect(encodeCwd("/")).toBe("");
  });

  it("encodes a Windows drive-letter path by stripping the drive prefix", () => {
    expect(encodeCwd("C:\\Users\\foo\\project")).toBe("Users-foo-project");
  });

  it("handles lowercase Windows drives", () => {
    expect(encodeCwd("c:\\foo")).toBe("foo");
  });

  it("handles a Windows path written with forward slashes", () => {
    expect(encodeCwd("C:/Users/foo/project")).toBe("Users-foo-project");
  });

  it("preserves server and share for UNC paths", () => {
    expect(encodeCwd("\\\\server\\share\\project")).toBe("server-share-project");
  });

  it("handles mixed separators", () => {
    expect(encodeCwd("/home\\user/project")).toBe("home-user-project");
  });

  it("collapses runs of leading dashes after separator replacement", () => {
    expect(encodeCwd("///foo")).toBe("foo");
  });

  it("returns an empty string for an empty cwd", () => {
    expect(encodeCwd("")).toBe("");
  });

  it("leaves a relative-looking path with no leading separator alone", () => {
    expect(encodeCwd("foo/bar")).toBe("foo-bar");
  });
});

describe("streamToOutputFile", () => {
  it("survives successful compaction without duplicate retained rows or skipped post-compaction turns", async () => {
    const path = outputPath();
    const cwd = "/repo";
    writeInitialEntry(path, "agent-a", "start", cwd);
    const session = createSession([
      { role: "user", content: "start" },
      { role: "assistant", content: "pre-compaction answer" },
    ]);
    const cleanup = streamToOutputFile(session, path, "agent-a", cwd);

    session.emit({ type: "compaction_start" });
    session.messages.splice(
      0,
      session.messages.length,
      { role: "user", content: "start" },
      { role: "assistant", content: "retained pre-compaction answer" },
    );
    session.emit({ type: "compaction_end", result: { tokensBefore: 123 }, reason: "context_length" });
    await Promise.resolve();

    session.messages.push(
      { role: "user", content: "post-compaction question" },
      { role: "assistant", content: "post-compaction answer" },
    );
    session.emit({ type: "turn_end" });
    cleanup();

    expect(readRows(path).map((row) => row.message.content)).toEqual([
      "start",
      "pre-compaction answer",
      "post-compaction question",
      "post-compaction answer",
    ]);
  });

  it.each([
    ["aborted", { type: "compaction_end", aborted: true, result: { tokensBefore: 123 }, reason: "context_length" }],
    ["failed", { type: "compaction_end", reason: "context_length" }],
  ] as const)("does not re-anchor after %s compaction_end", async (_label, event) => {
    const path = outputPath();
    const cwd = "/repo";
    writeInitialEntry(path, "agent-a", "start", cwd);
    const session = createSession([
      { role: "user", content: "start" },
      { role: "assistant", content: "pre-compaction answer" },
    ]);
    const cleanup = streamToOutputFile(session, path, "agent-a", cwd);

    session.emit({ type: "compaction_start" });
    session.emit(event);
    await Promise.resolve();

    session.messages.push(
      { role: "user", content: "next question" },
      { role: "assistant", content: "next answer" },
    );
    session.emit({ type: "turn_end" });
    cleanup();

    expect(readRows(path).map((row) => row.message.content)).toEqual([
      "start",
      "pre-compaction answer",
      "next question",
      "next answer",
    ]);
  });
});
