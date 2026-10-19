import { describe, expect, it } from "vitest";

import { renderContentStub, renderDiff, renderList, renderSingle, renderTree, splitDiffFiles } from "../render.js";

describe("renderSingle", () => {
  it("renders a PR with meta, body, and comments", () => {
    const md = renderSingle(
      "pr",
      {
        number: 42,
        title: "Add feature",
        state: "OPEN",
        isDraft: true,
        author: { login: "octocat" },
        labels: [{ name: "enhancement" }, { name: "wip" }],
        baseRefName: "main",
        headRefName: "feat",
        additions: 10,
        deletions: 2,
        body: "Body text",
        url: "https://github.com/o/r/pull/42",
        comments: [{ author: { login: "reviewer" }, body: "LGTM", createdAt: "2026-01-01" }],
      },
      { owner: "o", repo: "r" },
    );
    expect(md).toContain("# PR #42 · Add feature");
    expect(md).toContain("**OPEN**");
    expect(md).toContain("draft");
    expect(md).toContain("author @octocat");
    expect(md).toContain("labels: enhancement, wip");
    expect(md).toContain("`feat` → `main`");
    expect(md).toContain("+10 / -2");
    expect(md).toContain("Body text");
    expect(md).toContain("## Comments (1)");
    expect(md).toContain("### @reviewer · 2026-01-01");
    expect(md).toContain("LGTM");
  });

  it("degrades gracefully on missing fields", () => {
    const md = renderSingle("issue", { number: 1 }, undefined);
    expect(md).toContain("# Issue #1");
    expect(md).toContain("author @unknown");
    expect(md).toContain("_(no description)_");
  });
});

describe("renderList", () => {
  it("renders items", () => {
    const md = renderList(
      "pr",
      [
        { number: 1, state: "OPEN", title: "First", author: { login: "a" }, updatedAt: "2026-01-02", isDraft: true },
        { number: 2, state: "MERGED", title: "Second", author: { login: "b" }, labels: [{ name: "bug" }] },
      ],
      { owner: "o", repo: "r" },
      "all",
    );
    expect(md).toContain("# PRs · o/r · state=all");
    expect(md).toContain("**#1** OPEN [draft] — First · @a · updated 2026-01-02");
    expect(md).toContain("**#2** MERGED — Second · @b · bug");
    expect(md).toContain("2 item(s)");
  });

  it("handles empty list", () => {
    expect(renderList("issue", [], undefined, "open")).toContain("_(no matching items)_");
  });
});

const SAMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/b.ts b/src/b.ts
index 333..444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-foo
+bar`;

describe("splitDiffFiles", () => {
  it("splits by git header and captures b-side path", () => {
    const files = splitDiffFiles(SAMPLE_DIFF);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[0].section).toContain("+new");
    expect(files[1].section).toContain("+bar");
  });

  it("returns empty for empty diff", () => {
    expect(splitDiffFiles("")).toEqual([]);
  });
});

describe("renderDiff", () => {
  it("mode=list enumerates files", () => {
    const md = renderDiff(SAMPLE_DIFF, 5, "list", undefined);
    expect(md).toContain("2 file(s)");
    expect(md).toContain("1. `src/a.ts`");
    expect(md).toContain("2. `src/b.ts`");
  });

  it("mode=all includes the full diff", () => {
    const md = renderDiff(SAMPLE_DIFF, 5, "all", undefined);
    expect(md).toContain("+new");
    expect(md).toContain("+bar");
  });

  it("mode=slice selects the file by path", () => {
    const md = renderDiff(SAMPLE_DIFF, 5, "slice", "src/b.ts");
    expect(md).toContain("file 2/2 · `src/b.ts`");
    expect(md).toContain("+bar");
    expect(md).not.toContain("+new");
  });

  it("mode=slice out of range explains", () => {
    expect(renderDiff(SAMPLE_DIFF, 5, "slice", "missing.ts")).toContain("No diff for path 'missing.ts'");
  });
});

describe("renderTree", () => {
  it("lists directories before files with a drill hint", () => {
    const out = renderTree(
      [
        { name: "z.ts", type: "file", size: 10 },
        { name: "lib", type: "dir", size: 0 },
        { name: "a.ts", type: "file", size: 20 },
      ],
      { owner: "o", repo: "r" },
      "src",
    );
    const dirIndex = out.indexOf("- lib/");
    const fileIndex = out.indexOf("- a.ts");
    expect(dirIndex).toBeGreaterThan(-1);
    expect(fileIndex).toBeGreaterThan(dirIndex);
    expect(out).toContain("gh://o/r/src/<name>");
  });

  it("marks an empty directory", () => {
    expect(renderTree([], { owner: "o", repo: "r" }, "")).toContain("_(empty)_");
  });
});

describe("renderContentStub", () => {
  it("describes a binary file with size and sha", () => {
    const out = renderContentStub(
      { kind: "binary", name: "x.png", path: "img/x.png", size: 2048, sha: "deadbeef" },
      { owner: "o", repo: "r" },
    );
    expect(out).toContain("binary file");
    expect(out).toContain("2048 bytes");
    expect(out).toContain("deadbeef");
  });

  it("describes a too-large file with size and sha", () => {
    const out = renderContentStub(
      { kind: "too-large", name: "big.bin", path: "big.bin", size: 2_000_000, sha: "cafe" },
      { owner: "o", repo: "r" },
    );
    expect(out).toContain("too large");
    expect(out).toContain("2000000 bytes");
    expect(out).toContain("cafe");
  });
});

describe("copyable paths", () => {
  it("includes host, repository and ref in tree entry paths", () => {
    const md = renderTree([{ name: "a.ts", type: "file", size: 1 }], { owner: "o", repo: "r" }, "src", "feature/x", "ghe.example.com");
    expect(md).toContain("`gh://ghe.example.com/o/r/src/a.ts?ref=feature%2Fx`");
  });
  it("uses qualified paths for listed items", () => {
    expect(renderList("issue", [{ number: 7 }], { owner: "o", repo: "r" }, "open", "ghe.example.com")).toContain("`gh-issue://ghe.example.com/o/r/7`");
    expect(renderList("pr", [{ number: 7 }], { owner: "o", repo: "r" }, "open")).toContain("`gh-pr://o/r/7`");
  });
  it("uses qualified diff path and full diff hints", () => {
    const md = renderDiff(SAMPLE_DIFF, 7, "list", undefined, { owner: "o", repo: "r" }, "ghe.example.com");
    expect(md).toContain("gh-pr://ghe.example.com/o/r/7/diff/src/a.ts");
    expect(md).toContain("gh-pr://ghe.example.com/o/r/7.diff");
  });
});

describe("PR single view enrichment", () => {
  it("renders review metadata, filters thread-container reviews, orders threads, and links head files", () => {
    const oid = "abcdef1234567890abcdef1234567890abcdef12";
    const md = renderSingle("pr", {
      number: 7, headRefOid: oid, reviewDecision: "CHANGES_REQUESTED", body: "Description",
      reviews: [
        { author: { login: "empty" }, state: "COMMENTED", body: " \n" },
        { author: { login: "reviewer" }, state: "CHANGES_REQUESTED", submittedAt: "2026-01-01", body: "Needs work" },
        { author: { login: "approver" }, state: "APPROVED", body: "" },
        { author: { login: "commenter" }, state: "COMMENTED", body: "A review comment" },
      ],
      comments: [{ author: { login: "discussion" }, body: "General comment" }],
    }, { owner: "o", repo: "r" }, "ghe.example.com", { threads: [
      { id: "resolved", path: "old.ts", line: 4, isResolved: true, resolvedBy: { login: "fixer" }, comments: { nodes: [{ body: "hidden resolved detail" }] } },
      { id: "active", path: "src/a.ts", line: 8, originalLine: 5, isResolved: false, comments: { nodes: [{ databaseId: 123, author: { login: "reviewer" }, createdAt: "2026-01-02", body: "Please fix" }] } },
      { id: "outdated", path: "src/b.ts", line: null, originalLine: 9, isOutdated: true, isResolved: false, comments: { nodes: [] } },
    ] });
    expect(md).toContain("head abcdef1");
    expect(md).toContain("review: CHANGES_REQUESTED");
    expect(md).toContain("## Reviews (3)");
    expect(md).not.toContain("@empty");
    expect(md).toContain("### @reviewer · CHANGES_REQUESTED · 2026-01-01");
    expect(md).toContain("Needs work");
    expect(md).toContain("### @approver · APPROVED");
    expect(md).toContain("A review comment");
    expect(md).toContain("## Review threads (3, 1 resolved)");
    expect(md).toContain("### src/a.ts:8 · unresolved · thread active");
    expect(md).toContain("**@reviewer** · 2026-01-02 · comment 123");
    expect(md).toContain("Please fix");
    expect(md).toContain("### src/b.ts:9 · unresolved · outdated · thread outdated");
    expect(md).toContain("- old.ts:4 · resolved by @fixer · thread resolved");
    expect(md.indexOf("thread active")).toBeLessThan(md.indexOf("thread resolved"));
    expect(md).not.toContain("hidden resolved detail");
    expect(md.indexOf("## Reviews")).toBeLessThan(md.indexOf("## Review threads"));
    expect(md.indexOf("## Review threads")).toBeLessThan(md.indexOf("## Comments"));
    expect(md).toContain("General comment");
    expect(md).toContain("Changed files: gh-pr://ghe.example.com/o/r/7/diff");
    expect(md).toContain("Full diff: gh-pr://ghe.example.com/o/r/7.diff");
    expect(md).toContain(`Files at head: gh://ghe.example.com/o/r/?ref=${oid}`);
  });

  it.each([
    ["SUCCESS", "passed"], ["NEUTRAL", "passed"], ["SKIPPED", "passed"],
    ["FAILURE", "failed"], ["CANCELLED", "failed"], ["TIMED_OUT", "failed"],
    ["ACTION_REQUIRED", "failed"], ["ERROR", "failed"],
    ["PENDING", "pending"], [null, "pending"], ["UNKNOWN", "pending"],
  ])("normalizes CheckRun and StatusContext %s as %s", (state, outcome) => {
    for (const check of [{ name: "run", status: state === null ? "IN_PROGRESS" : "COMPLETED", conclusion: state }, { context: "legacy", state }]) {
      const md = renderSingle("pr", { number: 7, statusCheckRollup: [check] }, { owner: "o", repo: "r" });
      expect(md).toContain(`checks: ${outcome === "passed" ? 1 : 0} passed, ${outcome === "failed" ? 1 : 0} failed, ${outcome === "pending" ? 1 : 0} pending`);
      if (outcome === "failed") expect(md).toContain(`failing: ${"name" in check ? "run" : "legacy"}`);
      else expect(md).not.toContain("failing:");
    }
  });

  it("aggregates mixed check types and handles empty or missing checks", () => {
    const md = renderSingle("pr", { number: 7, statusCheckRollup: [
      { name: "unit", conclusion: "SUCCESS" }, { context: "lint", state: "FAILURE" },
      { name: "build", conclusion: "ERROR" }, { name: "queued", status: "QUEUED", conclusion: null },
    ] }, { owner: "o", repo: "r" });
    expect(md).toContain("checks: 1 passed, 2 failed, 1 pending");
    expect(md).toContain("failing: lint, build");
    expect(md).toContain("gh-pr://o/r/7/diff");
    expect(md).not.toContain("Files at head:");
    expect(renderSingle("pr", { statusCheckRollup: [] }, undefined)).toContain("checks: 0 passed, 0 failed, 0 pending");
    expect(renderSingle("pr", {}, undefined)).not.toContain("checks:");
  });

  it("shows safe unavailable thread metadata without changing issue views", () => {
    expect(renderSingle("pr", { number: 7 }, undefined, "github.com", { unavailable: "request failed" })).toContain("_Review threads unavailable: request failed_");
    const json = { number: 7, headRefOid: "abcdef1", reviews: [], statusCheckRollup: [], comments: [] };
    const issue = renderSingle("issue", json, { owner: "o", repo: "r" }, "github.com", { threads: [] });
    expect(issue).toContain("## Comments (0)");
    for (const prOnly of ["head abcdef1", "## Reviews", "## Review threads", "checks:", "Changed files:"]) expect(issue).not.toContain(prOnly);
  });
});

const EDGE_DIFF = `diff --git a/src/with b/name.ts b/src/with b/name.ts
--- a/src/with b/name.ts
+++ b/src/with b/name.ts
@@ -1,2 +1,3 @@
-old
--- a/not-a-path
+new
+++ b/not-a-path
+extra
 context
diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
--- a/deleted.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-also gone
diff --git a/old.ts b/new b/name.ts
similarity index 100%
rename from old.ts
rename to new b/name.ts
diff --git a/added.ts b/added.ts
new file mode 100644
--- /dev/null
+++ b/added.ts
@@ -0,0 +1 @@
+added
diff --git a/mode.ts b/mode.ts
old mode 100644
new mode 100755`;

describe("diff path and statistics mechanics", () => {
  it("prefers patch paths, falls back for renames/mode changes, and counts only hunk lines", () => {
    const files = splitDiffFiles(EDGE_DIFF);
    expect(files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions }))).toEqual([
      { path: "src/with b/name.ts", status: "modified", additions: 3, deletions: 2 },
      { path: "deleted.ts", status: "deleted", additions: 0, deletions: 2 },
      { path: "new b/name.ts", status: "renamed", additions: 0, deletions: 0 },
      { path: "added.ts", status: "added", additions: 1, deletions: 0 },
      { path: "mode.ts", status: "modified", additions: 0, deletions: 0 },
    ]);
    expect(files[0].section).toContain("+++ b/not-a-path");
    expect(files[1].section).toContain("+++ /dev/null");
  });

  it("lists totals and per-file status/counts with selectable paths", () => {
    const md = renderDiff(EDGE_DIFF, 7, "list", undefined, { owner: "o", repo: "r" });
    expect(md).toContain("5 file(s) · +4 / -4");
    expect(md).toContain("`src/with b/name.ts` · +3 / -2 · modified · `gh-pr://o/r/7/diff/src/with b/name.ts`");
    expect(md).toContain("`deleted.ts` · +0 / -2 · deleted");
    expect(md).toContain("`new b/name.ts` · +0 / -0 · renamed");
    expect(md).toContain("`added.ts` · +1 / -0 · added");
    const slice = renderDiff(EDGE_DIFF, 7, "slice", "src/with b/name.ts");
    expect(slice).toContain("+extra");
    expect(slice).not.toContain("deleted file mode");
  });
});
