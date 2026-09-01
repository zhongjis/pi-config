# Extension Model Role Config

Shared tool-owned LLM calls use `tool_models.json` role config instead of per-extension constants.

Load order:

1. built-in defaults in `extensions/lib/tool-models.ts`
2. global `~/.pi/agent/tool_models.json`
3. project `.pi/tool_models.json`

Later layers override earlier layers.

`install.sh` symlinks the repo's top-level `tool_models.json` into the global path.

## Schema

```json
{
  "version": 1,
  "roles": {
    "summary.session": "gpt-5.4-mini,gemini-3-flash,claude-haiku-4-5,qwen3.5-plus,qwen2.5-coder:14b",
    "commit": "claude-haiku-4-5,gpt-5.4-mini,opencode-go/qwen3.5-plus,llama-swap/qwen2.5-coder:7b",
    "guard.tool": "openai-codex/gpt-5.6-luna:low,anthropic/claude-haiku-4-5"
  },
  "tools": {
    "smart-sessions.summary": { "role": "summary.session" },
    "boomerang.commit": { "role": "commit" },
    "smart-tool-guards.classifier": { "role": "guard.tool" }
  }
}
```

Rules:

- `roles.<name>` is a comma-separated model chain parsed by `parseModelChain`.
- Re-defining a role replaces the whole inherited chain.
- `tools.<key>` objects merge with inherited rule objects.
- `tools.<key>.chain` is a direct escape hatch and wins over `role`.
- `null` clears inherited `role` or `chain`; a tool value of `null` clears both.
- Invalid JSON or invalid shape is diagnosed and ignored; built-in defaults still load.

## Built-in tool keys

| Tool key | Built-in role | Purpose | Consumer |
|---|---|---|---|
| `smart-sessions.summary` | `summary.session` | One-line session-name summary | `extensions/smart-sessions/index.ts` |
| `boomerang.commit` | `commit` | `/boomerang:commit` target model | `extensions/boomerang/commit.ts` |
| `smart-tool-guards.classifier` | `guard.tool` | Classify deferred guarded built-in `bash` commands | `extensions/smart-tool-guards/src/classifier.ts` |

## Extension behavior

### `smart-tool-guards`

Guarded built-in `bash` commands that are neither deterministic danger nor exact `pwd` resolve `smart-tool-guards.classifier`. Its built-in role is `guard.tool`, with chain `openai-codex/gpt-5.6-luna:low,anthropic/claude-haiku-4-5`. Fu Xi and the protected read-only subagents opt into this guard through trusted scope providers; other callers bypass it.

Global or project config may replace the entire `guard.tool` chain, repoint the tool key to another role, or set a direct tool `chain`; a direct chain wins over its role. Clearing the selection, an unavailable model or auth, provider errors, cancellation, and invalid classifier verdicts fail closed and block the guarded command.

### `smart-sessions`

Legacy `session-summary.json` still has highest priority when both `provider` and `model` are non-blank. That explicit pair calls `ctx.modelRegistry.find(provider, model)` and fails hard if unavailable.

When either field is blank or missing, `smart-sessions` resolves `smart-sessions.summary` from `tool_models.json` and uses the resolved model object for auth and `complete()`.

### `boomerang`

`/boomerang:commit` resolves `boomerang.commit` at command time from `ctx.cwd`, then feeds the candidates into the existing commit resolver. The existing context-window gate remains: if every configured commit model is unavailable or too small, it falls back to the current model with the existing warning.

## Related docs

- [`model-selection-and-fallback.md`](./model-selection-and-fallback.md) — model chain parsing/resolution details.
