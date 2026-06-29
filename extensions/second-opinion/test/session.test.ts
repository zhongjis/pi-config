import { describe, it, expect } from "vitest";
import {
  buildScopedReviewPrompt,
  buildSessionScopePrompt,
  collectSessionWritePaths,
} from "../src/session.js";

describe("collectSessionWritePaths", () => {
  it("collects write/edit tool paths from assistant entries", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "read", arguments: { path: "src/read.ts" } },
            { type: "toolCall", name: "edit", arguments: { path: "@src/edit.ts" } },
            { type: "toolCall", name: "write", arguments: JSON.stringify({ path: "/tmp/out.ts" }) },
            { type: "toolCall", name: "edit", arguments: { path: "src/edit.ts" } },
          ],
        },
      },
    ];

    expect(collectSessionWritePaths(entries)).toEqual(["src/edit.ts", "/tmp/out.ts"]);
  });
});

describe("session review prompts", () => {
  it("builds agent scope-selection prompt with path hints", () => {
    const prompt = buildSessionScopePrompt(["src/a.ts"], "/repo");

    expect(prompt).toContain("Codex session review requested.");
    expect(prompt).toContain("Current cwd: /repo");
    expect(prompt).toContain("- src/a.ts");
    expect(prompt).toContain("codex_review_session_scope");
  });

  it("builds scoped Codex prompt with include/exclude lists", () => {
    const prompt = buildScopedReviewPrompt({
      path: "/repo",
      include: ["src/a.ts"],
      exclude: ["pnpm-lock.yaml"],
      notes: "lockfile generated",
    }, "agent selected implementation files");

    expect(prompt).toContain("Repo: /repo");
    expect(prompt).toContain("Scope reason: agent selected implementation files");
    expect(prompt).toContain("- src/a.ts");
    expect(prompt).toContain("- pnpm-lock.yaml");
  });
});
