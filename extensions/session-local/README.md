# session-local

Session-local file storage via `local://` URI paths.

## What It Does

- Intercepts `read`, `write`, and `edit` tool calls that target `local://` paths
- Resolves `local://<path>` to a per-session storage directory under `~/.pi/agent/local/<session-id>/`
- `read local://` (root) generates a directory listing of the session-local storage
- Rewrites resolved paths back to `local://` in tool results so the LLM sees virtual paths
- Validates paths to prevent escaping the session storage root (no `..` traversal)

### Exported API

Other extensions can import storage utilities:

- `getSessionLocalPath(ctx, relativePath)` — Resolve a relative path within session-local storage
- `ensureSessionLocalRootDirectory(ctx)` — Create the session-local root directory
- `readSessionLocalFile(ctx, relativePath)` — Read a file from session-local storage
- `writeSessionLocalFile(ctx, relativePath, content)` — Write a file to session-local storage

## Hooks

- `tool_call` — Intercept and rewrite `local://` paths in read/write/edit calls
- `tool_result` — Rewrite resolved paths back to `local://` in results
- `tool_execution_end` — Clean up resolution tracking

## Files Worth Reading

- `index.ts` — Tool call/result interception and path rewriting
- `storage.ts` — Path resolution, validation, and file I/O utilities
