# session-local

Agent-tree-local file storage via `local://` URI paths. A parent session defaults to its own storage root; fresh `Agent` descendants inherit that root automatically.

## What It Does

- Intercepts `read`, `write`, and `edit` tool calls that target `local://` paths
- Resolves `local://<path>` under `~/.pi/agent/local/<root-session-id>/`
- Shares that root across a parent session and all fresh `Agent` descendants
- Keeps unrelated sessions on separate roots
- `read local://` (root) generates a directory listing of the Agent-tree storage
- Blocks `read` of a missing `local://` file with Agent-tree scope guidance
- Rewrites resolved paths back to `local://` in tool results so the LLM sees virtual paths
- Validates scope IDs and paths to prevent root escape (no `..` traversal)

This is same-user convenience scoping, not an OS sandbox. Extensions and processes running as the same user can access backing files directly.

### Exported API

Other extensions can import storage utilities:

- `getSessionLocalScopeId(ctx)` — Derive the active branch's effective Agent-tree root ID
- `seedSessionLocalScope(parentCtx, childSessionManager)` — Seed a fresh child with that root ID
- `getSessionLocalPath(ctx, relativePath)` — Resolve a relative path within Agent-tree-local storage
- `ensureSessionLocalRootDirectory(ctx)` — Create the Agent-tree-local root directory
- `readSessionLocalFile(ctx, relativePath)` — Read a file from Agent-tree-local storage
- `writeSessionLocalFile(ctx, relativePath, content)` — Write a file to Agent-tree-local storage

## Hooks

- `tool_call` — Intercept and rewrite `local://` paths in read/write/edit calls
- `tool_result` — Rewrite resolved paths back to `local://` in results
- `tool_execution_end` — Clean up resolution tracking

## Files Worth Reading

- `index.ts` — Tool call/result interception and path rewriting
- `storage.ts` — Path resolution, validation, and file I/O utilities
