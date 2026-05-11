# Guide 08 — Adapting Vendored Extensions

How to make surgical local changes to extensions vendored from upstream, while keeping future upstream syncs tractable.

## When this guide applies

- The extension under `extensions/<name>/` has a documented `## Upstream` section in its `README.md`.
- You want to change its behavior for this repo — add a feature, gate upstream behavior, fix a divergence.
- This is **not** first-time vendoring (see `pi-extension-vendoring`) and **not** an upstream sync (see `pi-vendored-extension-sync`).

## Adaptation principles

### 1. Additive over invasive

Prefer adding a new file over modifying an existing upstream file. A new file is a clean entry in the manifest (`Local-only file (not in upstream)`) and survives any upstream change.

| Preferred | Avoid |
|-----------|-------|
| New `src/background-supervision.ts` that imports from upstream files | Editing upstream `agent-runner.ts` to inline supervision logic |
| New optional field on an existing config type | Repurposing an existing field |
| New helper module re-exported from `index.ts` | Forking a large upstream utility |

Invasive changes are sometimes unavoidable (replacing a broken loader, gating a behavior that runs unconditionally upstream). When you make one, document it precisely in the manifest.

### 2. Gate with config, not with code

When the adaptation changes behavior conditionally, prefer a config flag over a hard fork. Upstream syncs are smoother if the upstream file is unchanged except for a single gate check.

Good:

```ts
// src/agent-runner.ts (upstream file, minimally modified)
const excluded = config.allowNesting
  ? EXCLUDED_TOOL_NAMES.filter((n) => n !== "Agent")
  : EXCLUDED_TOOL_NAMES;
```

Manifest entry:

```markdown
| `src/agent-runner.ts` | `allowNesting` gate on `EXCLUDED_TOOL_NAMES` filter | Allows nested `Agent` tool when frontmatter opts in |
| `src/types.ts` | Added `allowNesting` field to `AgentConfig` | `agent-runner.ts` gate needs it |
```

Bad: duplicating the whole runner into a `local-agent-runner.ts` just to toggle one line. The divergence surface is now the entire file.

### 3. Respect the existing layout tier

Vendored extensions usually arrive at the `src/` package tier. Keep it that tier. Do not promote it to a monorepo shape or nest deeper than `extensions/<name>/src/`. Adaptation files live under `src/` alongside upstream files.

### 4. Match local naming for public surface

Tool names, command names, config keys, and storage paths are the user-visible API. If the vendored extension already exposes `subagents:spawn`, a local adaptation MUST NOT rename it to `agents:spawn` without user approval — the rename is a breaking change and will surface as a warning gate on the next sync.

### 5. Follow CONVENTIONS.md for events

Any adaptation that emits or listens for events must use the contracts in `extensions/CONVENTIONS.md`:

- `user-prompted` once before first blocking tool UI prompt.
- `awaitingUserAction.suppressContinuationReminder` for persisted waiting state.
- `<namespace>:<event>` for lifecycle broadcasts.
- `<namespace>:rpc:<method>` plus `:reply:${requestId}` for RPC.

Invented ad-hoc channels inside a vendored extension are the same violation as anywhere else.

## Workflow

1. **Read the manifest.** `extensions/<name>/AGENTS.md` `## Local Tweaks` — know what already diverges. Your change may belong as a modification to an existing entry rather than a new one.
2. **Plan the change as additive-first.** Ask: can this be a new file? A new config field? If no, why not?
3. **Make the change.** Keep the diff tight. Do not tidy unrelated upstream code — it will inflate the next sync's diff.
4. **Update the manifest.** Add or extend the row for each touched file. See `.agents/skills/pi-extensions/references/local-tweaks-format.md` for the exact format.
5. **Validate.**
   - `lsp_diagnostics` on changed files.
   - `pnpm --dir extensions/<name> test` if the extension has local tests, otherwise `pnpm test:extensions`.
   - `pnpm lint:typecheck` when types, imports, or `package.json` changed.
6. **Commit with a greppable prefix.** Optional but recommended: `extensions/<name>: adapt: <subject>` so `git log extensions/<name>/` filters cleanly.

## Warning gates

Pause for user approval before any of these. Same gates as `pi-extension-vendoring`:

- Shared event/RPC contract changes consumed across extensions.
- Adding a non-built-in dependency to root `package.json`.
- Nesting a new package/toolchain inside the extension directory.
- Moving the extension to a larger layout tier when the smaller tier still fits.
- Introducing auth, secrets, background network, telemetry, or persistent storage not already present.
- Changing root scripts, root TypeScript config, or smoke discovery.
- Renaming public surface (tool names, command names, config keys, storage paths).

## Anti-patterns

- **Refactoring upstream code while you are there.** Every upstream line you move is a future merge conflict. Make the adaptation change and stop.
- **Deleting "unused" upstream code.** It may be used by upstream tests or by a code path you did not notice. If it is genuinely unused for this repo, document the deletion in the manifest with a specific reason.
- **Skipping the manifest because "it is obvious".** The sync agent cannot see what is obvious to you.
- **Using `git log` as the manifest.** Git history is chronological and includes sync commits, upstream merges, and reverts. The manifest is the snapshot.

## Cross-references

- Manifest format: [`references/local-tweaks-format.md`](../references/local-tweaks-format.md)
- First-time vendoring: `.agents/skills/pi-extension-vendoring/SKILL.md`
- Upstream sync: `.agents/skills/pi-vendored-extension-sync/SKILL.md`
- Event/RPC contracts: `extensions/CONVENTIONS.md`
- Extension layout tiers: [`../SKILL.md`](../SKILL.md) § Panda Harness Layout Tiers
