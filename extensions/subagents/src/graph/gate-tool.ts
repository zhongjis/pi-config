import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { firstMeaningfulLine, renderToolCall, renderToolExpanded, renderToolSummary } from "../../../lib/tool-output.js";
import { SUBAGENT_TOOL_NAMES } from "../agent-runner.js";
import type { createGateHandoff } from "./gate-handoff.js";

export function createGateResolutionTool(lookup: (id: string) => ReturnType<typeof createGateHandoff> | undefined) {
  return defineTool({
    name: SUBAGENT_TOOL_NAMES.RESOLVE_GRAPH_GATE,
    label: "Resolve Graph Gate",
    description: "Submit the human response collected with ask for a gate returned by get_agent_result. Copy run_id, gate_id and revision exactly; never invent human approval. Then collect with get_agent_result(wait:true).",
    parameters: Type.Object({
      run_id: Type.String(), gate_id: Type.String(), revision: Type.String(),
      response: Type.Object({ approved: Type.Boolean() }, { additionalProperties: false }),
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
      return { content: [{ type: "text" as const, text: "Human response accepted. Collect with get_agent_result(wait:true)." }],
        details: { kind: "graph-gate" as const, run_id: params.run_id, ...receipt } };
    },
  });
}
