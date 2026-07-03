import { Type } from "typebox";
import { buildTaskMetadata, type SessionStateContext, textResult } from "../lifecycle/store-glue.js";
import { renderTaskToolCall, renderTaskToolResult } from "./rendering.js";
import type { TaskToolDeps } from "./types.js";

export function registerCreateTool({ pi, runtime }: TaskToolDeps) {
  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Detailed description of what needs to be done, including context and acceptance criteria
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- Include enough detail in the description for another agent to understand and complete the task
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks
- Include \`agentType\` (e.g., "chengfeng" or another available custom subagent type) to mark tasks for subagent execution via TaskExecute`,
    promptGuidelines: [
      "When working on complex multi-step tasks, use TaskCreate to track progress and TaskUpdate to update status.",
      "Mark tasks as in_progress before starting work and completed when done.",
      "Use TaskList to check for available work after completing a task.",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "A brief title for the task" }),
      description: Type.String({ description: "A detailed description of what needs to be done" }),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress (e.g., 'Running tests')" })),
      agentType: Type.Optional(Type.String({ description: "Agent type for subagent execution (e.g., 'chengfeng' or another available custom subagent type). Tasks with agentType can be started via TaskExecute." })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
    }),

    renderCall(args, theme) {
      return renderTaskToolCall("TaskCreate", args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderTaskToolResult("TaskCreate", result, options, theme, context);
    },

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      runtime.autoClear.resetBatchCountdown();
      const baseMetadata = params.metadata ? { ...params.metadata } : {};
      if (params.agentType) baseMetadata.agentType = params.agentType;
      const { metadata } = buildTaskMetadata(
        Object.keys(baseMetadata).length > 0 ? baseMetadata : undefined,
        (_ctx ?? runtime.latestCtx) as SessionStateContext | undefined,
      );
      const task = runtime.store.create(params.subject, params.description, params.activeForm, metadata);
      runtime.widget.update();
      return Promise.resolve(textResult(`Task #${task.id} created successfully: ${task.subject}`));
    },
  });
}
