# Panda Harness — Documentation

Design notes, standards, and reference material for this Pi harness.

## Documentation Buckets

- `ideas/` — speculative, non-binding notes. Every document carries `Status: idea`.
- `specs/` — Panda Harness contracts. Every spec must declare exactly one `Status:` from the allowed lifecycle statuses below.
- `adr/` — append-only ADRs: one decision per `NNNN-short-title.md`, including why X was chosen over Y.
- `guides/` — task-oriented instructions (e.g. testing).
- `references/` — stable, citable external material.
- `rules/` — locked execution policy imported by root `AGENTS.md`; created when the first rule is adopted.

## Canonical Vocabulary

Domain language lives in [`CONTEXT.md`](../CONTEXT.md) — authoritative for terminology, not system behavior.

## Authority Order

Behavioral conflicts resolve: `rules/` → `adr/` → shipped `specs/` → `guides/` → `ideas/`. `references/` is evidence, never policy.

## Lifecycle Statuses

`idea` · `draft` · `planned` · `shipped` · `superseded` · `retired`. Every spec declares one of these statuses near its title. Ideas always use exact `Status: idea`. Supersede an ADR with a new ADR plus reciprocal `Supersedes` / `Superseded by` links; never edit ADR history.

## What This Harness Is

Panda Harness is a personal [Pi](https://github.com/mariozechner/pi-coding-agent) configuration repository. It bundles custom agents, runtime extensions, and a Nix-managed development environment into one place.

It is **not** a shared framework or general-purpose template — it's one user's opinionated setup for day-to-day coding agent work.

## Architecture

```
pi-config/
├── agents/              # Custom agent definitions (Chinese mythology naming)
├── extensions/          # Runtime Pi extensions (the main product code)
│   ├── lib/             # Shared utilities across extensions
│   ├── <name>/          # Each extension in its own directory
│   └── CONVENTIONS.md   # Event bus contract
├── docs/                # You are here
├── test/                # Root Vitest smoke + integration harness
├── scripts/             # Repo helper scripts
├── flake.nix            # Nix development environment
└── install.sh           # Symlink installer into ~/.pi/agent/
```

### Extension Loading

Pi discovers extensions by scanning `extensions/` for:
- `extensions/<name>/index.ts` — directory-based extensions (standard shape)

Each extension's `index.ts` exports a default function receiving `ExtensionAPI`. Extensions register tools, commands, hooks, and UI components through this API.

See `test/extensions.smoke.test.ts` for the exact discovery logic.

### Extension Layout Tiers

Extensions grow through three tiers (never skip ahead):

1. **Flat directory** — `extensions/foo/index.ts` + siblings
2. **Structured** — `extensions/foo/index.ts` + `src/` + `test/`
3. **Package** — Re-export-only `index.ts`, implementation under `src/`, `package.json` for vendored extensions

### Vendored Extensions

Check `extensions/*/package.json` for current vendored packages and their upstream `repository` metadata. The present package directories are `subagents/`, `tasks/`, and `lsp/`; their READMEs own adaptation notes.

### Agent Modes

Three agent personas switch context and tool access:
- **Kua Fu 夸父** (build) — default, general-purpose implementation
- **Fu Xi 伏羲** (plan) — plan drafting with restricted tools
- **Hou Tu 后土** (execute) — plan execution after handoff

See [modes.md](specs/modes.md) for the shipped mode contract and [orchistration.md](guides/orchistration.md) for the practical workflow guide.

## Specification Index

| Document | Purpose |
|----------|---------|
| [extensions.md](specs/extensions.md) | Extension README standard — what every extension README must contain |
| [extension-model-usage.md](specs/extension-model-usage.md) | Shared `tool_models.json` role schema for extension-owned LLM calls |
| [model-selection-and-fallback.md](specs/model-selection-and-fallback.md) | Model-chain parsing, profile filtering, and fallback behavior |
| [modes.md](specs/modes.md) | Agent modes design and switching behavior |
| [mode-prompt-parity.md](specs/mode-prompt-parity.md) | Shipped upstream baseline and local mode prompt invariants |
| [mode-prompt-audit-checklist.md](specs/mode-prompt-audit-checklist.md) | Active prompt audit procedure |
| [subagent-session-restoration.md](specs/subagent-session-restoration.md) | Retired removed-runtime record; current runtime has read-only monitor history |
| [omp-harness-migration.md](specs/omp-harness-migration.md) | Retired, time-bound OMP assessment; not current topology or an active migration decision |
| [agent-graph-implementation.md](guides/agent-graph-implementation.md) | Shipped graph runtime implementation boundary record |
| [agent-graph-reusable-workflows.md](specs/agent-graph-reusable-workflows.md) | Superseded portfolio proposal; consult committed `agent-graphs/` for current graphs |
| [herdr-agent-graph-presentation.md](specs/herdr-agent-graph-presentation.md) | Shipped hierarchy-first presentation contract for the Herdr agent-graph panel |
| [dynamic-agent-graph-expansion.md](specs/dynamic-agent-graph-expansion.md) | Shipped awaited typed fanout, all-settled collection, persistence, and dynamic monitor contract |
| [agent-graph-bounded-feedback.md](specs/agent-graph-bounded-feedback.md) | Shipped bounded feedback with durable runtime identity and partial synthesis |
| [agent-graph-yaml-invocation-gates.md](specs/agent-graph-yaml-invocation-gates.md) | Shipped saved graph YAML, `$graph:<name>` invocation, and decision gates |
| [dynamic-agent-graph-expansion-implementation.md](guides/dynamic-agent-graph-expansion-implementation.md) | Shipped implementation record; pre-migration paths and IDs are historical |
| [testing/README.md](guides/testing/README.md) | Testing overview for unit, integration, and subagents-e2e projects |
| [testing/unit-test.md](guides/testing/unit-test.md) | Unit test conventions |
| [testing/integration-test.md](guides/testing/integration-test.md) | Faux-provider integration testing approach |

## Guides

- [orchistration.md](guides/orchistration.md) — choosing and running the Kua Fu or Fu Xi → Hou Tu orchestration workflow
- [tool-output-tui-rendering.md](guides/tool-output-tui-rendering.md) — canonical Panda Harness standard for Pi tool and notification presentation

## Event Conventions

Extensions communicate through `pi.events`. The contract is defined in `extensions/CONVENTIONS.md`:
- `user-prompted` — same-run blocking tool prompts
- `awaitingUserAction.suppressContinuationReminder` — persisted waiting state
- `<namespace>:<event>` — lifecycle broadcasts
- `<namespace>:rpc:<method>` + `:reply:${requestId}` — request/response RPC

## Development

```bash
direnv allow && direnv reload   # enter Nix dev shell
pnpm install                    # install JS dependencies
pnpm test:extensions            # run extension tests + smoke
pnpm lint:typecheck             # typecheck
```

## Install

```bash
bash install.sh    # symlinks allowlist of runtime items into ~/.pi/agent/
```

Note: `install.sh` skips `AGENTS.md` and `settings.json` — those are managed by Home Manager / Nix.
