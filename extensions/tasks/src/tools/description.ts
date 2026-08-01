export const TASK_TOOL_DESCRIPTION = `Structured task tracking and coordination for a coding session, backed by a persistent widget and a file-backed dependency DAG. One tool, four operations selected by \`op\`.

## Operations

### \`op: "create"\` — add tasks (batch)
Pass \`tasks: [{ subject, description, activeForm?, metadata? }]\` (one or many). All-or-nothing: if any item is malformed the whole call fails and nothing is created. New tasks start \`pending\`. Returns the new IDs (e.g. \`Created 3 tasks: #4, #5, #6\`) so you can wire dependencies in a follow-up \`update\`.
- **subject**: brief imperative title (e.g. "Fix auth token expiry")
- **description**: full context and acceptance criteria
- **activeForm** (optional): present-continuous form for the spinner (e.g. "Fixing auth token expiry")

### \`op: "update"\` — change tasks (batch)
Pass \`tasks: [{ taskId, ...fields }]\` (one or many). Best-effort: each item is applied independently and the result reports \`Updated …\` / \`Rejected …\` per task; the call is a hard error only when every item is rejected. Updatable fields: \`status\`, \`subject\`, \`description\`, \`activeForm\`, \`owner\`, \`metadata\` (merge; null deletes a key), \`addBlocks\`, \`addBlockedBy\`.
- Status flow: \`pending → in_progress → completed\`. Use \`deleted\` to remove a task. Mark \`in_progress\` before starting and \`completed\` only when fully done.
- Dependencies: create tasks first, then \`update\` with \`addBlockedBy: ["<id>"]\` using the IDs returned by \`create\`.

### \`op: "list"\` — show all tasks
No payload. Returns tasks grouped Running / Ready / Blocked / Completed. Prefer Ready tasks and preserve ID order.

### \`op: "get"\` — task detail
Pass \`taskId\`. Returns subject, status, owner, description, blockers, and blocks.

## When to use
Use for complex multi-step work (3+ steps), plans, or when the user provides several tasks. Skip it for a single trivial action. Create tasks up front, mark one \`in_progress\` at a time, and \`list\` after each completion to pick the next ready task.`;
