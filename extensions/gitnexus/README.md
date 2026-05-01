# GitNexus

GitNexus knowledge graph integration for pi. It can append call-graph context to search/read results and exposes explicit tools for queries, context lookup, impact analysis, change detection, rename previews, and raw Cypher queries.

## Upstream

- **Source:** https://github.com/tintinweb/pi-gitnexus
- **Version:** 0.6.0, commit `db34bccdd29ee29f9185edb131a9ba0feb18d441`
- **License:** MIT for this extension. GitNexus itself is PolyForm Noncommercial; commercial use needs a separate GitNexus license.
- **Adapted:** Vendored under `extensions/gitnexus`; `cross-spawn` was replaced with Node's built-in `child_process.spawn`; package metadata points at local `index.ts`.

## Tools

### `gitnexus_list_repos`

List repositories indexed by GitNexus.

### `gitnexus_query`

Search the knowledge graph for execution flows.

**Parameters:** `query`, optional `task_context`, `goal`, `limit`, `max_symbols`, `include_content`, `repo`.

### `gitnexus_context`

Show callers, callees, and related processes for a symbol.

**Parameters:** optional `name`, `uid`, `file`, `file_path`, `include_content`, `repo`.

### `gitnexus_impact`

Analyze upstream/downstream blast radius for a symbol.

**Parameters:** `target`, `direction`, optional `depth`, `maxDepth`, `include_tests`, `includeTests`, `relationTypes`, `minConfidence`, `repo`.

### `gitnexus_detect_changes`

Map git changes to affected execution flows.

**Parameters:** optional `scope`, `base_ref`, `repo`.

### `gitnexus_rename`

Preview or request coordinated symbol renames. Use `dry_run` first.

**Parameters:** `new_name`, optional `symbol_name`, `symbol_uid`, `file_path`, `dry_run`, `repo`.

### `gitnexus_cypher`

Execute raw Cypher against the GitNexus graph.

**Parameters:** `query`, optional `repo`.

## Commands

- `/gitnexus` — Open status/settings menu.
- `/gitnexus status` — Show index status and augmentation counts.
- `/gitnexus analyze` — Build or rebuild the graph index.
- `/gitnexus on` / `/gitnexus off` — Enable/disable automatic result augmentation.
- `/gitnexus settings` — Configure command, timeout, and augmentation limits.
- `/gitnexus <pattern>` — Manual graph lookup.
- `/gitnexus query <text>` — Search execution flows.
- `/gitnexus context <name>` — Show symbol context.
- `/gitnexus impact <name>` — Show impact analysis.
- `/gitnexus help` — Show command reference.

## Hooks

- `before_agent_start` — Adds a one-line GitNexus hint when the project has a `.gitnexus/` index.
- `tool_result` — Appends graph context after `grep`, `find`, `bash`, `read`, and `read_many` results when auto-augment is enabled.
- `session_start` — Resets caches, loads config, resolves the GitNexus command, probes the binary, and reports index status.

## Configuration

Config file: `~/.pi/pi-gitnexus.json`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `cmd` | `string` | `"gitnexus"` | Command used to run GitNexus. |
| `autoAugment` | `boolean` | `true` | Enables automatic result augmentation. |
| `augmentTimeout` | `number` | `8` | Seconds to wait for `gitnexus augment`. |
| `maxAugmentsPerResult` | `number` | `3` | Max graph lookups per tool result. |
| `maxSecondaryPatterns` | `number` | `2` | Max file-derived secondary lookups. |

## Files Worth Reading

- `src/index.ts` — Extension registration, hooks, and slash command.
- `src/tools.ts` — Tool schemas and MCP calls.
- `src/gitnexus.ts` — Config, path safety, pattern extraction, augmentation.
- `src/mcp-client.ts` — Stdio JSON-RPC client for `gitnexus mcp`.

## Local Additions

Upstream skill files are vendored under `skills/` for provenance/package parity. This repo's `install.sh` does not symlink root `skills/`, so runtime availability depends on Pi package skill loading, not this extension symlink alone.
