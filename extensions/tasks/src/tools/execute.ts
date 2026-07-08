import { Type } from "typebox";
import { runSpawn } from "../lifecycle/apply-commands.js";
import { claimBlockerMessage, getClaimBlockerFailure, updateTask, warnClaimRejected } from "../lifecycle/fsm-dispatch.js";
import { textResult } from "../lifecycle/store-glue.js";
import type { Task } from "../types.js";
import { renderTaskToolCall, renderTaskToolResult } from "./rendering.js";
import type { TaskToolDeps } from "./types.js";

function isExecutableReadyTask(task: Task, runtime: TaskToolDeps["runtime"]): boolean {
  return task.status === "pending"
    && !task.owner
    && !getClaimBlockerFailure(runtime, task)
    && typeof task.metadata.agentType === "string"
    && task.metadata.agentType.trim() !== "";
}

export function registerExecuteTool({ pi, runtime, bridge }: TaskToolDeps) {
  pi.registerTool({
    name: "TaskExecute",
    label: "TaskExecute",
    description: `Execute one or more tasks as subagents.

## When to Use This Tool

- To start execution of tasks that have \`agentType\` set (created via TaskCreate with agentType parameter)
- Tasks must be \`pending\` with all blockedBy dependencies \`completed\`
- Each task runs as an independent background subagent

## Parameters

- **task_ids**: Array of task IDs to execute
- **additional_context**: Extra context appended to each agent's prompt
- **model**: Model override for agents (e.g., "sonnet", "haiku")
- **max_turns**: Maximum turns per agent`,
    promptGuidelines: [
      "Never use the Agent tool for tasks launched via TaskExecute — agents are already running.",
    ],
    parameters: Type.Object({
      task_ids: Type.Array(Type.String(), { description: "Task IDs to execute as subagents" }),
      additional_context: Type.Optional(Type.String({ description: "Extra context for agent prompts" })),
      model: Type.Optional(Type.String({ description: "Model override for agents" })),
      max_turns: Type.Optional(Type.Number({ description: "Max turns per agent", minimum: 1 })),
    }),

    renderCall(args, theme) {
      return renderTaskToolCall("TaskExecute", args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderTaskToolResult("TaskExecute", result, options, theme, context);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!runtime.subagentsAvailable) {
        return textResult(
          "Subagent execution is currently unavailable. " +
          "Ensure the @panda/pi-subagents extension is loaded and try again."
        );
      }

      const results: string[] = [];
      const launched: string[] = [];
      const requestedTaskIds = new Set(params.task_ids);
      const unrequestedExecutableReady = runtime.store
        .list()
        .filter(task => !requestedTaskIds.has(task.id) && isExecutableReadyTask(task, runtime));
      for (const taskId of params.task_ids) {
        const task = runtime.store.get(taskId);
        if (!task) {
          results.push(`#${taskId}: not found`);
          continue;
        }
        if (task.status !== "pending") {
          results.push(`#${taskId}: not pending (status: ${task.status})`);
          continue;
        }
        if (!task.metadata?.agentType) {
          results.push(`#${taskId}: no agentType set — create with agentType parameter or update metadata`);
          continue;
        }

        const blockerFailure = getClaimBlockerFailure(runtime, task);
        if (blockerFailure) {
          warnClaimRejected(blockerFailure);
          results.push(`#${taskId}: ${claimBlockerMessage(blockerFailure)}`);
          continue;
        }

        updateTask(runtime, taskId, { status: "in_progress" }, "internal");
        const outcome = await runSpawn(runtime, bridge, {
          taskId,
          agentType: task.metadata.agentType,
          additionalContext: params.additional_context,
          spawnOptions: {
            description: task.subject,
            isBackground: true,
            maxTurns: params.max_turns,
            ...(params.model ? { model: params.model } : {}),
          },
        });
        if (outcome.ok) {
          launched.push(`#${taskId} → agent ${outcome.agentId}`);
        } else {
          results.push(`#${taskId}: spawn failed — ${outcome.error}`);
        }
      }

      runtime.cascadeConfig = {
        additionalContext: params.additional_context,
        model: params.model,
        maxTurns: params.max_turns,
      };

      runtime.widget.update();

      const lines: string[] = [];
      if (launched.length > 0) {
        lines.push(
          `Launched ${launched.length} agent(s):\n${launched.join("\n")}\n` +
          `Use TaskOutput to check progress. Do not spawn additional agents for these tasks.`
        );
      }
      if (results.length > 0) lines.push(`Skipped:\n${results.join("\n")}`);
      if (unrequestedExecutableReady.length > 0 && launched.length > 0) {
        const ids = unrequestedExecutableReady.map(task => `#${task.id}`).join(", ");
        lines.push(`Also ready: ${ids}. Tip: pass multiple task_ids to run executable ready tasks in parallel when safe.`);
      }
      if (lines.length === 0) lines.push("No tasks to execute.");

      return textResult(lines.join("\n\n"));
    },
  });
}
