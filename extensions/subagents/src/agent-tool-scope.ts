/** agent-tool-scope.ts — enforces the tools a subagent may call. */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  type AccessDiagnostic,
  type AccessRule,
  resolveToolAccess,
  type ToolAccessGates,
  toolCandidates,
} from "../../lib/active-tools.js";

/**
 * Hold a subagent's tool calls to its `tools:` rules as extensions register tools
 * over time. `tools:` is permission only: Pi activates tools (its defaults or the
 * `defaultTools` setting, plus `direct`/`model-only` extension tools on
 * registration unless `defaultActive: false`) and owning extensions manage their
 * own activation. This scope never adds or removes active tools for policy.
 *
 * Extensions may call `registerTool` long after load — pi-mcp from `session_start`,
 * context-mode from `before_agent_start` — so scope has to be re-derived rather than
 * snapshotted. Every check re-reads the session's LIVE tool list and re-resolves the
 * shared signed-rule policy (`resolveToolAccess`), so late arrivals are judged too and
 * `@<extension>` groups pick up tools their extension registers later.
 *
 * Enforcement here, plus the runner's ceiling tool and nested `tool_call` hook:
 *
 *   - The ceiling tool hides every ungranted declaration while it is active. After
 *     bind and on every `turn_end` it is re-activated if another extension's
 *     `setActiveTools` dropped it. pi emits `turn_end` immediately before
 *     `prepareNextTurn` re-snapshots `agent.state.tools`, and session listeners run
 *     synchronously, so the fix lands in time for the next turn.
 *   - `beforeToolCall` blocks top-level calls outside the allowed set.
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
    /** The trusted ceiling tool that hides ungranted declarations. */
    ceilingToolName: string;
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

  const ensureCeiling = () => {
    if (!session.getAllTools().some((tool) => tool.name === ctx.ceilingToolName)) return;
    const active = session.getActiveToolNames();
    // setActiveToolsByName unconditionally rebuilds the system prompt, so skip
    // the no-op that steady-state turns would otherwise pay for every turn.
    if (!active.includes(ctx.ceilingToolName)) session.setActiveToolsByName([...active, ctx.ceilingToolName]);
  };

  // Pi activates the ceiling on registration; a session_start handler may have
  // replaced the active set since.
  ensureCeiling();
  allowedToolNames(); // report resolution diagnostics at spawn, not at the first call

  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") ensureCeiling();
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
