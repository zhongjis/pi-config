# Pi Tool Mapping

Superpowers upstream skills use Claude Code tool names. In this Pi harness, use these equivalents.

| Upstream reference | Pi-native replacement |
|---|---|
| `Skill` tool | Use Pi skill discovery, `/skill:<name>`, or `read` on the exact `SKILL.md` path when known. |
| `Task` tool | Use `Agent` to launch subagents; use pi-tasks only to track logical work. |
| Multiple `Task` calls | Launch multiple `Agent` calls with `run_in_background: true`, one per independent workstream. |
| Task result | Use `get_subagent_result`; use `steer_subagent` to correct a running background agent. |
| `TodoWrite` | Use `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet` for work tracking. |
| `Read` | Use `read`. |
| `Write` | Use `write`. |
| `Edit` | Use `edit`. |
| `Bash` | Use `bash` with `cwd`; never write `cd dir && command`. |

Do not use Weiping's `dispatch_agent` tool in this repo. It duplicates the existing supervised `Agent` workflow.
