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

  it("mode=slice returns the nth file (1-based)", () => {
    const md = renderDiff(SAMPLE_DIFF, 5, "slice", 2);
    expect(md).toContain("file 2/2 · `src/b.ts`");
    expect(md).toContain("+bar");
    expect(md).not.toContain("+new");
  });

  it("mode=slice out of range explains", () => {
    expect(renderDiff(SAMPLE_DIFF, 5, "slice", 9)).toContain("No file at index 9");
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
    expect(out).toContain("github://o/r/src/<name>");
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
