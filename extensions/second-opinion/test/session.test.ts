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
  it("transports cwd and path hints with the structured scope marker", () => {
    const cwd = "/repo";
    const path = "src/a.ts";
    const prompt = buildSessionScopePrompt([path], cwd);

    expect(prompt).toContain(cwd);
    expect(prompt).toContain(path);
    expect(prompt).toContain("codex_review_session_scope");
  });

  it("transports exact scoped review payload values", () => {
    const scope = {
      path: "/repo",
      include: ["src/a.ts"],
      exclude: ["pnpm-lock.yaml"],
      notes: "lockfile generated",
    };
    const reason = "agent selected implementation files";
    const prompt = buildScopedReviewPrompt(scope, reason);

    for (const value of [scope.path, ...scope.include, ...scope.exclude, scope.notes, reason]) {
      expect(prompt).toContain(value);
    }
  });
});
