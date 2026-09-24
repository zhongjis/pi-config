import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { WORKFLOW_RESULT_PREVIEW_CHARS } from "../src/constants.js";
import { graphRunCompletionText } from "../src/graph/notification.js";
import { createGraphRunTask, formatGraphRunNotification, type GraphRunTask, graphRunResultPreview } from "../src/graph/task.js";
import { createOutputFilePath } from "../src/output-file.js";

function completed(value: unknown): GraphRunTask {
  const t = createGraphRunTask({ id: "wf_note", script: "", meta: { name: "demo" } });
  t.status = "completed";
  t.value = value;
  t.endTime = t.startTime + 1;
  return t;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});
function ctxFor(cwd: string, notify?: (message: string, level: string) => void): ExtensionContext {
  return { cwd, hasUI: notify !== undefined, ui: { notify }, sessionManager: { getSessionId: () => "sess" } } as unknown as ExtensionContext;
}

describe("graphRunResultPreview", () => {
  it("prefers a top-level string summary over the full payload", () => {
    const t = completed({ summary: "short summary", details: "x".repeat(2000) });
    expect(graphRunResultPreview(t)).toBe("short summary");
  });

  it("falls back to a compact (not pretty) object encoding", () => {
    const t = completed({ a: 1, b: 2 });
    expect(graphRunResultPreview(t)).toBe('{"a":1,"b":2}');
  });

  it("caps at the preview length with a trailing ellipsis", () => {
    const t = completed("y".repeat(2000));
    const preview = graphRunResultPreview(t);
    expect(preview.length).toBe(WORKFLOW_RESULT_PREVIEW_CHARS);
    expect(preview.endsWith("\u2026")).toBe(true);
  });

  it("returns a short string result verbatim", () => {
    const t = completed("all done");
    expect(graphRunResultPreview(t)).toBe("all done");
  });
});

describe("formatGraphRunNotification", () => {
  it("inlines a short result and emits no result-file element", () => {
    const xml = formatGraphRunNotification(completed("all done"));
    expect(xml).toContain("<result>all done</result>");
    expect(xml).not.toContain("<result-file>");
  });

  it("marks truncation and links the artifact when a result file exists", () => {
    const t = completed("z".repeat(2000));
    t.resultPath = "/tmp/wf_note.workflow-result.txt";
    const xml = formatGraphRunNotification(t);
    expect(xml).toContain("<result-file>/tmp/wf_note.workflow-result.txt</result-file>");
    expect(xml).toContain("truncated");
    // The full >500-char body is never inlined.
    expect(xml).not.toContain("z".repeat(WORKFLOW_RESULT_PREVIEW_CHARS + 1));
  });
});

describe("graphRunCompletionText", () => {
  it("writes the complete result artifact and links it, dropping the legacy trailing line", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-note-"));
    tmpDirs.push(cwd);
    const t = completed("q".repeat(2000));
    const text = graphRunCompletionText(ctxFor(cwd), t);
    expect(t.resultPath).toBeDefined();
    expect(readFileSync(t.resultPath as string, "utf-8")).toBe("q".repeat(2000));
    expect(text).toContain(`<result-file>${t.resultPath}</result-file>`);
    expect(text).not.toContain("Full workflow result:");
    expect(text).not.toContain("q".repeat(WORKFLOW_RESULT_PREVIEW_CHARS + 1));
  });

  it("returns an inline notification with no artifact for a short result", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-note-"));
    tmpDirs.push(cwd);
    const t = completed("brief");
    const text = graphRunCompletionText(ctxFor(cwd), t);
    expect(t.resultPath).toBeUndefined();
    expect(text).toContain("<result>brief</result>");
    expect(text).not.toContain("<result-file>");
  });

  it("keeps the artifact-write warning and a capped inline preview when the file cannot be written", () => {
    const cwd = mkdtempSync(join(tmpdir(), "wf-note-"));
    tmpDirs.push(cwd);
    // Occupy the artifact path with a directory so writeFileSync throws EISDIR.
    const tasksDir = dirname(createOutputFilePath(cwd, "wf_note", "sess"));
    mkdirSync(join(tasksDir, "wf_note.workflow-result.txt"));
    const warnings: string[] = [];
    const t = completed("w".repeat(2000));
    const text = graphRunCompletionText(ctxFor(cwd, message => warnings.push(message)), t);
    expect(t.resultArtifactError).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(text).toContain("Warning:");
    expect(text).toContain("Full output remains in the expanded graph run report");
    expect(text).not.toContain("<result-file>");
  });
});
