import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGoal } from "./store.js";
import type { Goal, GoalStoreRef } from "./types.js";

type GoalContext = Pick<ExtensionContext, "cwd"> & {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionFile" | "getSessionDir" | "getSessionId">;
};

export function goalStoreRef(ctx: GoalContext): GoalStoreRef {
  const sessionFile = ctx.sessionManager.getSessionFile();
  const baseDir = sessionFile === undefined
    ? join(process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent"),
      "extensions", "goal", "no-session", createHash("sha256").update(ctx.cwd).digest("hex").slice(0, 24))
    : join(ctx.sessionManager.getSessionDir(), "extensions", "goal");
  return { baseDir, threadId: ctx.sessionManager.getSessionId() };
}

/** Read-only authority check. Missing goals return null; lookup/parse errors propagate. */
export function readGoalForContext(ctx: GoalContext): Promise<Goal | null> {
  return readGoal(goalStoreRef(ctx));
}
