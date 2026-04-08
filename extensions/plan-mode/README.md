# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- **Read-only tools**: Shared `agent-modes` plan mode now owns the restriction layer
- **Prometheus planner**: `/plan {request}` runs a dedicated planner agent and keeps the existing execution flow
- **Planner live progress**: streams Prometheus tool activity and current reply in the planner widget while planning is in progress
- **Planner clarification loop**: vague requests turn into short follow-up questions answered one by one before replanning
- **Bash allowlist**: Enforced by the shared `agent-modes` plan mode
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **Progress tracking**: Widget shows completion status during execution
- **[DONE:n] markers**: Explicit step completion tracking
- **Session persistence**: State survives session resume
- **Shared mode integration**: Enter plan mode with `/agent-mode plan`; `/plan` now only runs the planner inside that mode
- **Requires `agent-modes`**: This extension now expects the vendored `extensions/agent-modes/` runtime to be loaded

## Commands
- `/plan {request}` - Run the Prometheus planner while already in plan mode
- `/todos` - Show current plan progress

## Usage

### Fast path

1. Run `/agent-mode plan`
2. Run `/plan {request}`
3. Prometheus inspects the codebase and returns either `Decision: PLAN` with a `Plan:` block, or `Decision: NEEDS_MORE_DETAIL` with follow-up questions
4. While the planner runs, the planner widget streams Prometheus tool activity and current reply
5. Choose **Execute the plan**, **Stay in plan mode**, or **Refine the plan**
6. During execution, the agent marks steps complete with `[DONE:n]` tags

```text
Plan:
1. First step description
2. Second step description
3. Third step description
```

### Manual path

1. Enter plan mode with `/agent-mode plan`
2. Run `/plan {request}` to start the planner
3. The planner returns a numbered plan under a `Plan:` header
4. If the request is too vague, the planner asks targeted follow-up questions instead of inventing a plan
5. Choose what to do next from the plan-mode prompt

## How It Works

### Plan Mode (Read-Only)
- Shared `agent-modes` owns read-only tool restrictions and bash policy
- `/plan {request}` runs the Prometheus planner and shows its live progress in the planner widget
- Entering plan mode happens via `/agent-mode plan` only

### Execution Mode
- Full tool access restored
- Agent executes steps in order
- `[DONE:n]` markers track completion
- Widget shows progress
- **Refine the plan** reruns the Prometheus planner with the current plan plus your feedback
- **Needs-more-detail flow** asks clarification questions one at a time before rerunning the planner

### Command Allowlist

Safe commands (allowed):
- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands:
- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`
