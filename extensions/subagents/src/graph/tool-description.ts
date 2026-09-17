import { fileURLToPath } from "node:url";

export const graphSkillPath = fileURLToPath(new URL("../../skills/agent-graphs/SKILL.md", import.meta.url));

export const graphToolDescription = `Execute a typed agent graph (nodes + edges) only with explicit user opt-in to workflow/multi-agent orchestration; otherwise ask first. \`graph\` is a saved graph name (.pi/agent-graphs/<name>.graph.json) or an inline AgentGraph object; \`input\` is the graph input. Reading the authoring skill alone MUST NOT grant execution permission. Before authoring or modifying a graph, MUST read ${graphSkillPath}. The graph is validated before anything runs; the call returns a background task ID and notifies on completion (do not poll). Use /agents → Workflows for supervision.`;
