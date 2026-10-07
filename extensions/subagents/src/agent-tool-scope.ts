/** agent-tool-scope.ts — narrows the live tool set a subagent may call. */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  type AccessDiagnostic,
  type AccessRule,
  resolveToolAccess,
  selectActiveToolNames,
  type ToolAccessGates,
  toolCandidates,
} from "../../lib/active-tools.js";

/**
 * Keep a subagent's tool scope equal to its `tools:` rules as extensions
 * register tools over time.
 *
 * Extensions may call `registerTool` long after load — pi-mcp from `session_start`,
 * context-mode from `before_agent_start` — so scope has to be re-derived rather than
 * snapshotted. Every check re-reads the session's LIVE tool list and re-resolves the
 * shared signed-rule policy (`resolveToolAccess`), so late arrivals are judged too and
 * `@<extension>` groups pick up tools their extension registers later.
 *
 * Two enforcement points here, plus the runner's ceiling tool:
 *
 *   - `turn_end` re-narrows the ACTIVE set to the allowed tools (exposure-aware via
 *     `selectActiveToolNames`). pi emits `turn_end` immediately before
 *     `prepareNextTurn` re-snapshots `agent.state.tools`, and session listeners run
 *     synchronously, so the narrow lands in time for turns 2..N.
 *   - `beforeToolCall` blocks top-level calls outside the allowed set. Pi activates
 *     tools registered inside `prompt()` (e.g. during `before_agent_start`), after the
 *     install-time narrow; the runner's ceiling tool hides their declarations and this
 *     veto blocks the call.
 *
 * Both are installed on the session and deliberately NOT unsubscribed: they must
 * outlive the `runAgent` call so resumed/steered turns stay scoped. pi's `dispose()`
 * clears `_eventListeners`, so they die with the session rather than leaking.
 *
 * Trusted `<inline:`/`<sdk:` tools (StructuredOutput, the ceiling) are always allowed
 * by the policy. Resolution diagnostics are reported once, at the first computation.
 *
 * Only meaningful when extensions are loaded — without them the runner's static
 * built-in allowlist already gates the registry itself.
 */
export function installExtensionToolScope(
  session: AgentSession,
  ctx: {
    toolRules: readonly AccessRule[];
    gates?: ToolAccessGates;
    onDiagnostics?: (diagnostics: AccessDiagnostic[]) => void;
  },
): void {
  let reported = false;
  const allowedToolNames = (): Set<string> => {
    const { allowed, diagnostics } = resolveToolAccess(ctx.toolRules, toolCandidates(session.getAllTools()), ctx.gates);
    if (!reported) {
      reported = true;
      if (diagnostics.length > 0) ctx.onDiagnostics?.(diagnostics);
    }
    return allowed;
  };

  const renarrow = () => {
    const next = selectActiveToolNames(session.getAllTools(), allowedToolNames(), session.getActiveToolNames());
    const current = session.getActiveToolNames();
    // setActiveToolsByName unconditionally rebuilds the system prompt, so skip
    // the no-op that steady-state turns would otherwise pay for every turn.
    if (next.length !== current.length || next.some((n, i) => n !== current[i])) {
      session.setActiveToolsByName(next);
    }
  };

  // Activate what registered during session_start (eager MCP servers); pi would
  // otherwise leave only its default built-ins active at turn 1.
  renarrow();

  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") renarrow();
  });

  const priorBeforeToolCall = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    if (!allowedToolNames().has(context.toolCall.name)) {
      return {
        block: true,
        reason: `Tool "${context.toolCall.name}" is not available to this subagent.`,
      };
    }
    return priorBeforeToolCall?.(context, signal);
  };
}
