# codegraph

Vendored `@vndv/pi-codegraph` extension. Preserve upstream behavior unless local tweaks below say otherwise.

## Local Tweaks

Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Upstream `extensions/codegraph.ts` lives at directory entrypoint `extensions/codegraph/index.ts` | Repo requires extension directories with `index.ts`; no bare `extensions/*.ts` |
| `index.ts` | Tool `execute` injects `ctx.cwd` as `projectPath` only when params omit `projectPath`; explicit `projectPath` still wins. JSON-RPC stdout loop avoids assignment-in-expression. Same-project tool calls are serialized through a module-level queue; different resolved project paths remain independent. | Pi runtime cwd is correct project default in this harness; repo lint disallows assignment in expressions; CodeGraph MCP proxy is flaky under same-project parallel short-lived subprocesses |
| `index.ts` | Per-request JSON-RPC timeout (default 30s, override via `CODEGRAPH_TIMEOUT_MS`) in `createJsonRpcRequestSender`; on timeout the pending request rejects and the child is killed by the existing cleanup. | A hung `codegraph` subprocess otherwise blocks the agent indefinitely — and, with the same-project queue, blocks every queued same-project call behind it. Adapted from gripebomb/pi-codegraph-extension. |
| `index.ts` | `formatCodeGraphError(error, toolName)` maps `ENOENT`/spawn failures to install guidance and uninitialized-index errors to `codegraph init -i` guidance; tool `execute` throws the enriched message. | Raw spawn/stderr errors are not actionable for the agent or user. Adapted from gripebomb/pi-codegraph-extension. |
| `index.ts` | `findCodeGraphRoot` walks up from the validated project dir to the nearest ancestor (incl. itself) containing `.codegraph`; `resolveProjectCwd` returns that root, else the dir unchanged. | Launching pi in a subdirectory of an indexed repo should still resolve to the repo's index. Adapted from viniraioli/pi-codegraph. |
| `README.md` | Replaced upstream README with repo-standard concise docs and provenance | Repo docs omit install/development instructions and keep upstream metadata local |
| upstream `package.json` | Omitted; upstream metadata moved to `README.md` | No extension-local package/toolchain; no new deps |
| `LICENSE` | Copied upstream MIT license | Preserve vendored attribution/license text |

## Notes

- No new dependencies. Existing repo runtime provides `@earendil-works/pi-coding-agent` and `typebox`.
- `codegraph` CLI is assumed on `PATH`; tools spawn it per request.
