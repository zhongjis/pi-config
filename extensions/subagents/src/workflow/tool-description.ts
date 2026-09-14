import { fileURLToPath } from "node:url";

export const workflowSkillPath = fileURLToPath(new URL("../../skills/subagent-workflows/SKILL.md", import.meta.url));

export const workflowToolDescription = `Execute a deterministic multi-agent workflow only with explicit user opt-in to workflow execution or multi-agent orchestration; otherwise ask first. Reading or invoking the authoring skill alone MUST NOT grant execution permission. Before authoring or modifying a script, MUST read ${workflowSkillPath}. Returns immediately with a background task ID and notifies you on completion; do not poll or sleep waiting. Use /agents → Workflows for supervision.`;
