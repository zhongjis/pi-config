# session-local

Agent-tree-local file storage via `local://` URI paths. A parent session defaults to its own storage root; fresh agent descendants inherit that root automatically.

## What It Does

- Intercepts `read`, `write`, and `edit` tool calls that target `local://` paths
- Resolves `local://<path>` under `~/.pi/agent/local/<root-session-id>/`
- Shares that root across a parent session and all fresh agent descendants
- Keeps unrelated sessions on separate roots
- `read local://` (root) generates a directory listing of the Agent-tree storage
- Blocks `read` of a missing `local://` file with Agent-tree scope guidance
- Rewrites resolved paths back to `local://` in tool results so the LLM sees virtual paths
- Validates scope IDs and paths to prevent root escape (no `..` traversal)

This is same-user convenience scoping, not an OS sandbox. Extensions and processes running as the same user can access backing files directly.

### Exported API

Other extensions import path resolution and file helpers from [storage.ts](storage.ts). [index.ts](index.ts) registers the interception hooks.
