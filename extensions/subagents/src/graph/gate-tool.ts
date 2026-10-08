import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { firstMeaningfulLine, renderToolCall, renderToolExpanded, renderToolSummary } from "../../../lib/tool-output.js";
import { SUBAGENT_TOOL_NAMES } from "../agent-runner.js";
import type { createGateHandoff } from "./gate-handoff.js";

export function createGateResolutionTool(lookup: (id: string) => ReturnType<typeof createGateHandoff> | undefined) {
  return defineTool({
    name: SUBAGENT_TOOL_NAMES.RESOLVE_GRAPH_GATE,
    label: "Resolve Graph Gate",
    description: "Submit the decision for an escalated decision_gate returned by get_agent_result. Decide yourself or ask the human with ask; set decidedBy truthfully (\"human\" only when the human chose). Copy run_id, gate_id and revision exactly. Then collect with get_agent_result(wait:true).",
    parameters: Type.Object({
      run_id: Type.String(), gate_id: Type.String(), revision: Type.String(),
      response: Type.Object({
        answers: Type.Record(Type.String(), Type.Union([Type.Boolean(), Type.String(), Type.Number()])),
        decidedBy: Type.Union([Type.Literal("orchestrator"), Type.Literal("human")]),
      }, { additionalProperties: false }),
    }),
    renderCall(args, theme) { return renderToolCall("resolve_agent_graph_gate", args.run_id, theme); },
    renderResult(result, options, theme) {
      const text = result.content.map(part => part.type === "text" ? part.text : "").join("\n");
      return options.expanded ? renderToolExpanded(text) : renderToolSummary([firstMeaningfulLine(text)], theme, { expandable: true });
    },
    async execute(_id, params) {
      const gates = lookup(params.run_id);
      if (!gates) throw new Error(`Graph run not found: "${params.run_id}".`);
      const receipt = gates.resolve(params.gate_id, params.revision, params.response);
      return { content: [{ type: "text" as const, text: "Decision accepted. Collect with get_agent_result(wait:true)." }],
        details: { kind: "graph-gate" as const, run_id: params.run_id, ...receipt } };
    },
  });
}
