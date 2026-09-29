# Boomerang

Vendored `pi-boomerang` extension for token-efficient autonomous task execution. It runs a task, summarizes the resulting branch with Pi's session tree summarization, then hands concise context back to the orchestrator.

## Upstream

- Source: https://github.com/nicobailon/pi-boomerang
- Version: 0.7.0
- Commit: `1a5985b2d92cfa84ce1f470d100d02b368711a91`
- License: not declared upstream
- Local changes: adds `/boomerang:commit` and local tool rendering; README is in local repo format; upstream package files are omitted because root dependencies provide the required packages.

## Entry Points

- `/boomerang <task>` — run a task autonomously, then summarize the branch. Supports `--rethrow N` passes and `/a -> /b` prompt-template chains.
- `/boomerang:commit [args]` — run `commit [args]` through boomerang with the `git-master` skill injected.
- `boomerang` tool — agent-callable, disabled until `/boomerang tool on`.

Commands, subcommands, shortcuts, the tool schema, and lifecycle hooks are registered in [`index.ts`](index.ts); `/boomerang:commit` lives in [`commit.ts`](commit.ts).

## Configuration

- Tool settings persist at `~/.pi/agent/boomerang.json`; keys and defaults are defined in [`index.ts`](index.ts).
- `/boomerang:commit` resolves the `boomerang.commit` rule / `commit` role from `~/.pi/agent/tool_models.json` or project `.pi/tool_models.json`.

## Local Additions

Adds `/boomerang:commit [args]`, a local shortcut that sends plain `commit [args]` to boomerang while injecting `git-master` and resolving the shared `boomerang.commit` model role.