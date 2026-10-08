# Extension Model Role Config

Status: shipped

Shared tool-owned LLM calls use `tool_models.json` role config instead of per-extension constants.

Load order:

1. built-in defaults in [`extensions/lib/tool-model-defaults.ts`](../../extensions/lib/tool-model-defaults.ts), loaded by [`extensions/lib/tool-models.ts`](../../extensions/lib/tool-models.ts)
2. global `~/.pi/agent/tool_models.json`
3. project `.pi/tool_models.json`

Later layers override earlier layers.

`install.sh` symlinks the repo's root [`tool_models.json`](../../tool_models.json) into the global path. That file and the built-in defaults hold the current role chains.

## Schema

```json
{
  "version": 1,
  "roles": {
    "<role>": "<model chain>"
  },
  "tools": {
    "<tool key>": { "role": "<role>" }
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

Each extension-owned call reads one tool key, named `<extension>.<purpose>`. The built-in keys and their roles are defined in [`tool-model-defaults.ts`](../../extensions/lib/tool-model-defaults.ts). The consumers are [`smart-sessions`](../../extensions/smart-sessions/index.ts), [`boomerang`](../../extensions/boomerang/commit.ts), [`smart-tool-guards`](../../extensions/smart-tool-guards/src/classifier.ts), [`multimodal-look`](../../extensions/multimodal-look/index.ts), and the `decision_gate` agent-graph node, which reads `subagents.decision_gate` through `resolveToolModelChain` in [`tool-models.ts`](../../extensions/lib/tool-models.ts).

## Extension behavior

### `smart-tool-guards`

Guarded built-in `bash` commands that are neither deterministic danger nor exact `pwd` resolve `smart-tool-guards.classifier`. Its built-in role is `guard.tool`. Fu Xi and the protected read-only subagents opt into this guard through trusted scope providers; other callers bypass it.

Global or project config may replace the entire `guard.tool` chain, repoint the tool key to another role, or set a direct tool `chain`; a direct chain wins over its role. The classifier tries each candidate in order — the resolved `guard.tool` chain, then the current session model — and advances to the next whenever a candidate cannot produce a valid verdict (cleared selection, unavailable or unauthenticated model, provider error, cancellation, or invalid verdict). The first valid allow/block verdict wins and a valid block is never downgraded; only when no candidate yields a verdict does it fail closed and block the guarded command.

### `smart-sessions`

An explicit `session-summary.json` pair has highest priority when both `provider` and `model` are non-blank. That explicit pair calls `ctx.modelRegistry.find(provider, model)` and fails hard if unavailable.

When either field is blank or missing, `smart-sessions` resolves `smart-sessions.summary` from `tool_models.json` and uses the resolved model object for auth and `complete()`.

### `boomerang`

`/boomerang:commit` resolves `boomerang.commit` at command time from `ctx.cwd`, then feeds the candidates into the commit resolver, which applies a context-window gate: if every configured commit model is unavailable or too small, it falls back to the current model with a warning.

### `multimodal-look`

`look_at` resolves `multimodal-look.inspect` through `vision.inspect`; global and project layers may replace the role, repoint the tool, or set a preferred direct chain. If no configured candidate resolves, it uses the current model only when that model declares image input support; otherwise an explicit error is thrown before a child session is created.

### `subagents`

The `decision_gate` node resolves `subagents.decision_gate` as one mixed chain walked in written order. An entry that `ctx.modelRegistry.findOfType("classifier", provider, id)` resolves is a classifier model; any other entry is a chat model that runs the decision-gate agent fallback. Unavailable or failed entries advance to the next. When the chain is exhausted the gate escalates to the orchestrator; the current session model is never a fallback. `resolveToolModelChain` returns the raw parsed entries without availability filtering.

## Related docs

- [`model-selection-and-fallback.md`](./model-selection-and-fallback.md) — model chain parsing/resolution details.
