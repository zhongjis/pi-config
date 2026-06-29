import { describe, it, expect } from "vitest";
import { parseReviewMode, planCodexReviewJobs, type GitRunner } from "../src/detect.js";

function fakeGit(outputs: Record<string, string | null>): GitRunner {
  return async (args: string[]) => outputs[args.join(" ")] ?? null;
}

describe("parseReviewMode", () => {
  it("returns default for empty args", () => {
    expect(parseReviewMode("")).toEqual({ kind: "default" });
    expect(parseReviewMode("   ")).toEqual({ kind: "default" });
  });

  it("returns session for 'session'", () => {
    expect(parseReviewMode("session")).toEqual({ kind: "session" });
    expect(parseReviewMode("SESSION")).toEqual({ kind: "session" });
  });

  it("rejects old and unknown modes", () => {
    expect(parseReviewMode("uncommitted").kind).toBe("invalid");
    expect(parseReviewMode("base origin/main").kind).toBe("invalid");
    expect(parseReviewMode("commit HEAD").kind).toBe("invalid");
    expect(parseReviewMode("session extra").kind).toBe("invalid");
    expect(parseReviewMode("unknown").kind).toBe("invalid");
  });
});

describe("planCodexReviewJobs", () => {
  it("plans branch and dirty jobs when both exist", async () => {
    const jobs = await planCodexReviewJobs(fakeGit({
      "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": "origin/main",
      "diff --name-only origin/main...HEAD": "src/feature.ts",
      "status --porcelain": " M src/dirty.ts",
    }), "/repo");

    expect(jobs).toEqual([
      { label: "branch changes vs origin/main", argv: ["review", "--base", "origin/main"] },
      { label: "dirty working tree", argv: ["review", "--uncommitted"] },
    ]);
  });

  it("plans dirty job without a base", async () => {
    const jobs = await planCodexReviewJobs(fakeGit({
      "status --porcelain": "?? new.ts",
    }), "/repo");

    expect(jobs).toEqual([
      { label: "dirty working tree", argv: ["review", "--uncommitted"] },
    ]);
  });

  it("uses origin HEAD fallback", async () => {
    const jobs = await planCodexReviewJobs(fakeGit({
      "symbolic-ref --quiet refs/remotes/origin/HEAD": "refs/remotes/origin/main",
      "diff --name-only origin/main...HEAD": "src/feature.ts",
      "status --porcelain": "",
    }), "/repo");

    expect(jobs).toEqual([
      { label: "branch changes vs origin/main", argv: ["review", "--base", "origin/main"] },
    ]);
  });

  it("returns no jobs for clean branch with base", async () => {
    const jobs = await planCodexReviewJobs(fakeGit({
      "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": "origin/main",
      "diff --name-only origin/main...HEAD": "",
      "status --porcelain": "",
    }), "/repo");

    expect(jobs).toEqual([]);
  });

  it("adds scoped prompt to each job", async () => {
    const jobs = await planCodexReviewJobs(fakeGit({
      "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": "origin/main",
      "diff --name-only origin/main...HEAD": "src/feature.ts",
      "status --porcelain": " M src/dirty.ts",
    }), "/repo", { prompt: "Review only src/feature.ts" });

    expect(jobs.map((job) => job.argv.at(-1))).toEqual([
      "Review only src/feature.ts",
      "Review only src/feature.ts",
    ]);
  });

  it("throws when clean and no base exists", async () => {
    await expect(planCodexReviewJobs(fakeGit({
      "status --porcelain": "",
    }), "/repo")).rejects.toThrow("Could not determine a base ref");
  });
});
