## Purpose

Provide Agent-tree-local file storage through `local://` paths.

## Ownership

- Owns virtual-path interception, scope validation, storage helpers, and result rewriting.
- Subagents seeds fresh descendants with the parent's effective storage root.

## Local Contracts

- Parent and fresh descendants MUST share a root; unrelated sessions remain separate.
- Only read/write/edit resolve these virtual paths; shell commands receive literal strings.
- Path and scope validation MUST reject traversal and root escape.
- File-operation results MUST rewrite resolved target paths back to virtual paths.
- Root listings include the backing path; missing-file reads provide Agent-tree scope guidance.
- This is same-user convenience scoping, not an OS sandbox.

## Work Guidance

- [README](README.md) owns path grammar and exported storage API.
- Cross-extension consumers SHOULD reuse [storage helpers](storage.ts).
- Backing-file access by same-user processes MUST NOT be described as isolation failure.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/session-local/test`.
- [Storage](test/storage.test.ts) and [interception](test/index.test.ts) cover scope and virtual-path behavior.

## Child DOX Index

- None; this document owns the entire subtree.
