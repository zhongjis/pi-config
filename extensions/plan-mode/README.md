# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- **Read-only tools**: Restricts available tools to read, bash, grep, find, ls, ask
- **Prometheus planner**: `/plan {request}` runs a dedicated planner agent and keeps the existing execution flow
- **Planner status**: shows the active planner and request while planning is in progress
- **Planner decision gate**: Prometheus decides whether a request is plannable or needs more detail, so vague inputs do not turn into junk todos
- **Bash allowlist**: Only read-only bash commands are allowed
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **Progress tracking**: Widget shows completion status during execution
- **[DONE:n] markers**: Explicit step completion tracking
- **Session persistence**: State survives session resume

## Commands

- `/plan` - Toggle plan mode
- `/plan {request}` - Enable plan mode and run the Prometheus planner immediately
- `/todos` - Show current plan progress
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## Usage

### Fast path

1. Run `/plan {request}`
2. Plan mode enables read-only tools and calls `agents/prometheus.md`
3. Prometheus inspects the codebase and returns either `Decision: PLAN` with a `Plan:` block, or `Decision: NEEDS_MORE_DETAIL` with follow-up questions
4. While the planner runs, plan mode shows which planner is active and what request it is working on
5. Choose **Execute the plan**, **Stay in plan mode**, or **Refine the plan**
6. During execution, the agent marks steps complete with `[DONE:n]` tags

```text
Plan:
1. First step description
2. Second step description
3. Third step description
```

### Manual path

1. Enable plan mode with `/plan` or `--plan`
2. Ask the agent to analyze code and create a plan
3. The agent should return a numbered plan under a `Plan:` header
4. If the request is too vague, the planner asks for more detail instead of inventing a plan
5. Choose what to do next from the plan-mode prompt

## How It Works

### Plan Mode (Read-Only)
- Only read-only tools available
- Bash commands filtered through allowlist
- `/plan {request}` calls the Prometheus planner directly
- Bare `/plan` keeps the original manual read-only planning mode

### Execution Mode
- Full tool access restored
- Agent executes steps in order
- `[DONE:n]` markers track completion
- Widget shows progress
- **Refine the plan** reruns the Prometheus planner with the current plan plus your feedback

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
