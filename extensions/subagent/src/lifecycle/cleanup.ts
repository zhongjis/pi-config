/**
 * Shutdown cleanup for the subagent extension.
 *
 * On `session_shutdown` the session is going down and there is nothing left to
 * consume agent results, so abort everything immediately and tear down RPC
 * handlers, the supervision timer, pending notifications, and the manager.
 */

import type { SubagentRuntimeContext } from "./supervision.js";

export function registerCleanup(ctx: SubagentRuntimeContext): void {
  const {
    pi,
    manager,
    widget,
    unsubRpcHandlers,
    setCurrentCtx,
    releaseManager,
    clearBackgroundSupervision,
  } = ctx;

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    unsubRpcHandlers();
    setCurrentCtx(undefined);
    releaseManager();
    manager.abortAll();
    clearBackgroundSupervision();
    manager.dispose();
    widget.dispose();
  });
}
