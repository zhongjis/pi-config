# codegraph

Vendored `@vndv/pi-codegraph` extension. Preserve upstream behavior unless local tweaks below say otherwise.

## Local Tweaks

Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Upstream `extensions/codegraph.ts` lives at directory entrypoint `extensions/codegraph/index.ts` | Repo requires extension directories with `index.ts`; no bare `extensions/*.ts` |
| `index.ts` | Tool `execute` injects `ctx.cwd` as `projectPath` only when params omit `projectPath`; explicit `projectPath` still wins. JSON-RPC stdout loop avoids assignment-in-expression. Same-project tool calls are serialized through a module-level queue; different resolved project paths remain independent. | Pi runtime cwd is correct project default in this harness; repo lint disallows assignment in expressions; CodeGraph MCP proxy is flaky under same-project parallel short-lived subprocesses |
| `index.ts` | Per-request JSON-RPC timeout (default 30s, override via `CODEGRAPH_TIMEOUT_MS`) in `createJsonRpcRequestSender`; on timeout the pending request rejects and the child is killed by the existing cleanup. `tools/call` timeouts get one 250–750ms backoff retry inside the same-project queue; final timeout errors include attempt count. | A hung `codegraph` subprocess otherwise blocks the agent indefinitely — and, with the same-project queue, blocks every queued same-project call behind it. One narrow retry absorbs transient MCP `tools/call` stalls without retrying initialize/spawn/tool/user errors. Adapted from gripebomb/pi-codegraph-extension. |
| `index.ts` | `formatCodeGraphError(error, toolName)` maps `ENOENT`/spawn failures to install guidance and uninitialized-index/manual-recovery errors to `codegraph init <project-root>` + `codegraph status` guidance; tool `execute` throws the enriched message. | Raw spawn/stderr errors are not actionable for the agent or user. Adapted from gripebomb/pi-codegraph-extension. |
| `index.ts` | `findCodeGraphRoot` walks up from the validated project dir to the nearest ancestor (incl. itself) with a valid `.codegraph` project marker (`codegraph.db`, `.gitignore`, or empty marker), bounded by the containing `.git` dir/file when present; `resolveProjectCwd` returns that root, else the dir unchanged. Invalid/global ancestor `.codegraph` dirs (for example telemetry/daemon data under `$HOME`) are ignored. Marker-root tool calls canonicalize MCP `projectPath` arguments to that root. | Launching pi in a subdirectory of an indexed repo should still resolve to the repo's index, CodeGraph MCP should see the indexed root even when `ctx.cwd`/`projectPath` is nested, and unrelated parent/home `.codegraph` data must not opt projects into guidance or auto-init. Adapted from viniraioli/pi-codegraph plus local safety hardening. |
| `index.ts` | Teaching layer: prescriptive tool descriptions (explore = primary / Read-equivalent, node = Read replacement, search = locating-only, callers/callees/impact = "don't reconstruct with grep"); `before_agent_start` guidance is gated on validated `findCodeGraphRoot(ctx.cwd)`, re-evaluated each turn (a mid-session `.codegraph` marker is picked up next turn), includes one short cold-start transparency sentence, and carries anti-patterns (no grep re-verify, no re-opening explored files, no `codegraph_node` looping); dropped the redundant per-tool `promptSnippet`/`promptGuidelines`. | Steer the model to CodeGraph at the tool-choice point without polluting no-marker sessions or duplicating tokens. Ideas adapted from colbymchenry/codegraph's MCP server-instructions. |
| `index.ts` | `initCodeGraphProject(root, signal)` spawns `codegraph init <root>` with independent `CODEGRAPH_INIT_TIMEOUT_MS`, shared canonical-root promise, abort/timeout kill, and sanitized bounded diagnostics. | Supports marker-gated first-query auto-init while keeping recovery output bounded and `codegraph_status` inspect-only. |
| `index.ts` | Non-status tool calls first run a normal `tools/call` (`serve`). If a marker-root call reports uninitialized, it runs shared `initCodeGraphProject` inside the same-root queue and retries the original call once (`serve -> init -> serve`). No-marker uninitialized calls return manual guidance without init. `codegraph_status` stays inspect-only: no-marker returns no-marker text without spawning, ready marker roots return MCP status, cold marker roots return cold-enabled text, and status never runs init. | Enables bare-marker first-query bootstrapping without status-side mutation or surprise init for projects that lack a marker. |
| `test/index.test.ts` | Focused coverage for `before_agent_start` marker/no-marker guidance and prompt bloat; root detection rejects invalid/global ancestor `.codegraph` dirs and stops at `.git` dir/file boundaries; init helper coverage for canonical sharing, failure diagnostics, init timeout, abort, and promise clearing. | Locks local teaching/init/root-detection behavior while marker-gated retry remains separate from status inspection. |
| `README.md` | Replaced upstream README with repo-standard concise docs and provenance | Repo docs omit install/development instructions and keep upstream metadata local |
| upstream `package.json` | Omitted; upstream metadata moved to `README.md` | No extension-local package/toolchain; no new deps |
| `LICENSE` | Copied upstream MIT license | Preserve vendored attribution/license text |

## Notes

- No new dependencies. Existing repo runtime provides `@earendil-works/pi-coding-agent` and `typebox`.
- `codegraph` CLI is assumed on `PATH`; CodeGraph queries spawn it per request, while no-marker `codegraph_status` returns without spawning.

## Child DOX Index

No child `AGENTS.md` files. This file owns all files under `extensions/codegraph/`.
