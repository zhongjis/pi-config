# codegraph

Vendored CodeGraph Pi extension. Registers native `codegraph_*` tools that proxy one request to a local CodeGraph MCP subprocess for symbol search, callers/callees, impact, exploration, node details, status, and indexed file trees.

## Provenance

No longer a straight fork. This extension began as a vendored copy of `@vndv/pi-codegraph` and has since absorbed QoL, limit, and timeout fixes from several other Pi CodeGraph adapters, plus locally-authored changes — it no longer tracks any single upstream. The underlying engine is the `@colbymchenry/codegraph` CLI, which every adapter (including this one) proxies via `codegraph serve --mcp`.

**Base vendor — `@vndv/pi-codegraph@0.1.8`**

- **Source:** https://github.com/vndv/pi-codegraph
- **gitHead:** `c5fbafdf89b987b5f868cbad521fc852af82db61`
- **License:** MIT; copied in `LICENSE`
- **npm tarball:** `vndv-pi-codegraph-0.1.8.tgz`
- **shasum:** `cc61254ed346c2728fa054d49935d8c63dca7878`
- **integrity:** `sha512-viJnU4zxpPSPzvn4YCaAK7K73zTpHyg71MbpCfIBF+7kUPZ6JrrHQE1w1yRRjcfQ3BaA4/bAny2WVpSBxcCxFg==`

**Absorbed fixes (sourced from peer adapters / locally authored):**

- Per-request JSON-RPC timeout + subprocess kill (`CODEGRAPH_TIMEOUT_MS`) and one retry after a `tools/call` timeout — adapted from `gripebomb/pi-codegraph-extension`.
- Actionable spawn / uninitialized-index error guidance — adapted from `gripebomb/pi-codegraph-extension`.
- Monorepo `.codegraph` ancestor discovery (`findCodeGraphRoot`) — adapted from `viniraioli/pi-codegraph`.
- Same-project call serialization queue, `ctx.cwd` default project path, directory entrypoint, and lint-compliance — locally authored.

`AGENTS.md` holds the per-change table (what / why / origin) and is the source of truth for divergences.

## Tools

All tools accept optional `projectPath` to query another absolute indexed project directory; when omitted, this repo build uses the active Pi `ctx.cwd`.

- `codegraph_search` — symbol search by name. Params: `query`, optional `kind`, `limit`, `projectPath`.
- `codegraph_callers` — functions or methods that call `symbol`. Params: `symbol`, optional `limit`, `projectPath`.
- `codegraph_callees` — functions or methods called by `symbol`. Params: `symbol`, optional `limit`, `projectPath`.
- `codegraph_impact` — impact radius for changing `symbol`. Params: `symbol`, optional `depth`, `projectPath`.
- `codegraph_explore` — related source grouped by file. Params: `query`, optional `maxFiles`, `projectPath`.
- `codegraph_node` — symbol details plus callers/callees. Params: `symbol`, optional `includeCode`, `projectPath`.
- `codegraph_status` — CodeGraph index status. Params: optional `projectPath`.
- `codegraph_files` — indexed file tree. Params: optional `path`, `pattern`, `format`, `includeMetadata`, `maxDepth`, `projectPath`.

## Hooks

- `before_agent_start` — when the active project (`ctx.cwd`) has a `.codegraph/` index, appends guidance steering CodeGraph tools before grep/read, including anti-patterns. Re-checked each turn, so an index created mid-session (`codegraph init -i`) is picked up on the next turn; skipped entirely for non-indexed projects. Per-tool descriptions carry the when-to-prefer steering.

## Configuration / Requirements

- `codegraph` CLI must be available on `PATH`; no new repo dependency is added.
- Target projects must have a `.codegraph/` index initialized for useful results.
- Each tool starts internal subprocess `codegraph serve --mcp --path <project>` for its call. This is not a root MCP server and adds no `settings.json` MCP config.
- Same-project tool calls are serialized inside this extension to avoid CodeGraph MCP proxy races under parallel agent tool use; different `projectPath` values may still run concurrently.
- Project paths resolve to the nearest ancestor directory containing `.codegraph/`, so launching pi inside a subdirectory of an indexed repo still works.
- Each JSON-RPC request to the subprocess times out after 30s (override with the `CODEGRAPH_TIMEOUT_MS` env var); on timeout the subprocess is killed so a hung `codegraph` cannot block the agent or the same-project queue. If `tools/call` times out, the extension waits 250–750ms and retries once inside that same queue; initialize timeouts/failures, spawn errors, tool `isError` results, aborts, invalid paths, and uninitialized projects are not retried.
- When the `codegraph` CLI is missing from `PATH` or the project has no `.codegraph/` index, tools fail with actionable install / `codegraph init -i` guidance instead of a raw spawn error.
