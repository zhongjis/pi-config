# codegraph

Vendored CodeGraph Pi extension. Registers native `codegraph_*` tools that proxy one request to a local CodeGraph MCP subprocess for symbol search, callers/callees, impact, exploration, node details, status, and indexed file trees.

## Upstream

- **Source:** https://github.com/vndv/pi-codegraph
- **Package:** `@vndv/pi-codegraph@0.1.8`
- **gitHead:** `c5fbafdf89b987b5f868cbad521fc852af82db61`
- **License:** MIT; copied in `LICENSE`
- **npm tarball:** `vndv-pi-codegraph-0.1.8.tgz`
- **shasum:** `cc61254ed346c2728fa054d49935d8c63dca7878`
- **integrity:** `sha512-viJnU4zxpPSPzvn4YCaAK7K73zTpHyg71MbpCfIBF+7kUPZ6JrrHQE1w1yRRjcfQ3BaA4/bAny2WVpSBxcCxFg==`
- **Adapted:** copied upstream `extensions/codegraph.ts` to `extensions/codegraph/index.ts`; default project path now comes from `ctx.cwd` when `projectPath` is omitted.

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

- `before_agent_start` — appends guidance encouraging CodeGraph tools for structural code questions before grep/read fallback.

## Configuration / Requirements

- `codegraph` CLI must be available on `PATH`; no new repo dependency is added.
- Target projects must have a `.codegraph/` index initialized for useful results.
- Each tool starts internal subprocess `codegraph serve --mcp --path <project>` for its call. This is not a root MCP server and adds no `settings.json` MCP config.
