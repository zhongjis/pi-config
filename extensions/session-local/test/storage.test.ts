import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  getSessionLocalRoot,
  getSessionLocalScopeId,
  seedSessionLocalScope,
  SESSION_LOCAL_SCOPE_CUSTOM_TYPE,
} from "../storage.js";

type TestEntry = {
  type: string;
  customType?: string;
  data?: unknown;
};

function createManager(sessionId: string, branch: TestEntry[] = []) {
  return {
    getSessionId: () => sessionId,
    getBranch: () => branch,
  };
}

describe("session-local Agent-tree scope", () => {
  it("defaults a parent session to its own local storage root", () => {
    const ctx = { sessionManager: createManager("parent-session") };

    expect(getSessionLocalScopeId(ctx)).toBe("parent-session");
    expect(getSessionLocalRoot(ctx)).toBe(join(getAgentDir(), "local", "parent-session"));
  });

  it("falls back to the current session when branch access is unavailable", () => {
    const ctx = {
      sessionManager: {
        getSessionId: () => "lightweight-session",
      },
    };

    expect(getSessionLocalScopeId(ctx as never)).toBe("lightweight-session");
    expect(getSessionLocalRoot(ctx as never)).toBe(join(getAgentDir(), "local", "lightweight-session"));
  });

  it("derives the inherited root scope from the active branch", () => {
    const ctx = {
      sessionManager: createManager("child-session", [
        {
          type: "custom",
          customType: SESSION_LOCAL_SCOPE_CUSTOM_TYPE,
          data: { version: 1, rootScopeId: "parent-session" },
        },
      ]),
    };

    expect(getSessionLocalScopeId(ctx)).toBe("parent-session");
    expect(getSessionLocalRoot(ctx)).toBe(join(getAgentDir(), "local", "parent-session"));
  });

  it("rejects an unsafe inherited root scope ID", () => {
    const ctx = {
      sessionManager: createManager("child-session", [
        {
          type: "custom",
          customType: SESSION_LOCAL_SCOPE_CUSTOM_TYPE,
          data: { version: 1, rootScopeId: "../escape" },
        },
      ]),
    };

    expect(() => getSessionLocalScopeId(ctx)).toThrow(
      "Rejected session local path: session ID contains unsupported characters.",
    );
  });

  it("seeds descendants with the original Agent-tree root scope", () => {
    const childBranch: TestEntry[] = [];
    const child = {
      ...createManager("child-session", childBranch),
      appendCustomEntry: vi.fn((customType: string, data?: unknown) => {
        childBranch.push({ type: "custom", customType, data });
        return "child-entry";
      }),
    };
    const grandchild = {
      ...createManager("grandchild-session"),
      appendCustomEntry: vi.fn(() => "grandchild-entry"),
    };

    expect(seedSessionLocalScope({ sessionManager: createManager("parent-session") }, child)).toBe("parent-session");
    expect(child.appendCustomEntry).toHaveBeenCalledWith(
      SESSION_LOCAL_SCOPE_CUSTOM_TYPE,
      { version: 1, rootScopeId: "parent-session" },
    );

    expect(seedSessionLocalScope({ sessionManager: child }, grandchild)).toBe("parent-session");
    expect(grandchild.appendCustomEntry).toHaveBeenCalledWith(
      SESSION_LOCAL_SCOPE_CUSTOM_TYPE,
      { version: 1, rootScopeId: "parent-session" },
    );
  });
});
