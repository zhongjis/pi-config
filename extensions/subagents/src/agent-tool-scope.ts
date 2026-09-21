/** agent-tool-scope.ts — narrows the live tool set a subagent may call. */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { computeActiveToolNames, DEFAULT_BUILTIN_TOOL_NAMES } from "../../lib/active-tools.js";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "./structured-output.js";

/**
 * Keep a subagent's tool scope correct as extensions register tools over time.
 *
 * Extensions may call `registerTool` long after load — pi-mcp from `session_start`,
 * context-mode from `before_agent_start` — so scope has to be re-derived rather than
 * snapshotted. This re-reads the session's LIVE tool list on every re-narrow and
 * re-runs the shared `computeActiveToolNames` policy, so late arrivals are judged too.
 * (`computeActiveToolNames` snapshots its input, so the live re-read is what keeps a
 * late-registered MCP/context tool from being dropped forever.)
 *
 * Two enforcement points, because neither covers the whole picture:
 *
 *   - `turn_end` re-narrows the ACTIVE set. pi emits `turn_end` immediately before
 *     `prepareNextTurn` re-snapshots `agent.state.tools`, and session listeners run
 *     synchronously, so the narrow lands in time for turns 2..N.
 *   - `beforeToolCall` blocks out-of-scope calls. Turn 1 cannot be narrowed at all:
 *     `before_agent_start` fires INSIDE `prompt()` and may widen the tool set, but
 *     `createContextSnapshot()` freezes that turn's tools immediately after — there
 *     is no hook in between. A call-time check is the only correct guard there.
 *
 * Both are installed on the session and deliberately NOT unsubscribed: they must
 * outlive the `runAgent` call so resumed/steered turns stay scoped. pi's `dispose()`
 * clears `_eventListeners`, so they die with the session rather than leaking.
 *
 * Only meaningful when extensions are loaded — under `noExtensions`/`isolated` the
 * static `tools:` allowlist already gates the registry itself.
 */
export function installExtensionToolScope(
  session: AgentSession,
  ctx: {
    builtinToolNames: string[];
    extensions: true | string[] | false;
    extensionTools: string[] | undefined;
    allowNesting: boolean | undefined;
    isolated: boolean | undefined;
    structuredOutput?: boolean;
  },
): void {
  const { builtinToolNames, extensions, extensionTools, allowNesting, isolated } = ctx;

  // The tools the LLM may call right now, recomputed from the LIVE registry on
  // every call. `computeActiveToolNames` gates built-ins by `builtinToolNames`,
  // filters extension tools by `extensionTools` (exact names or trailing-`*`
  // wildcards), and drops the nested-subagent tools unless `allowNesting`. Its
  // output order follows the live available list, so this IS the final active set.
  const computeActive = (): string[] => {
    const active = computeActiveToolNames({
      availableToolNames: session.getAllTools().map((t) => t.name),
      builtinToolNames,
      builtinToolUniverse: DEFAULT_BUILTIN_TOOL_NAMES,
      extensions,
      extensionTools,
      allowNesting,
      isolated,
    });
    if (ctx.structuredOutput && !active.includes(STRUCTURED_OUTPUT_TOOL_NAME)) active.push(STRUCTURED_OUTPUT_TOOL_NAME);
    return active;
  };

  const renarrow = () => {
    const next = computeActive();
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
    if (!new Set(computeActive()).has(context.toolCall.name)) {
      return {
        block: true,
        reason: `Tool "${context.toolCall.name}" is not available to this subagent.`,
      };
    }
    return priorBeforeToolCall?.(context, signal);
  };
}
