# Panda Harness — Documentation

Design contracts, guides, and reference material for this Pi harness.

## Documentation Buckets

- `ideas/` — speculative, non-binding notes. Every document carries `Status: idea`.
- `specs/` — Panda Harness contracts. Every spec declares exactly one `Status:` from the lifecycle statuses below.
- `adr/` — append-only ADRs: one decision per `NNNN-short-title.md`, including why X was chosen over Y.
- `guides/` — task-oriented instructions for current behavior.
- `references/` — stable, citable external material.
- `rules/` — locked execution policy imported by root `AGENTS.md`; created when the first rule is adopted.

## Writing Rules

- **Current state only.** No dates, commit narratives, "previously" or "no longer" prose, migration notes, before/after stories, or implementation records. ADRs and `CHANGELOG.md` files are exempt.
- **Code is the source of truth.** Link to the owning code instead of copying tools, parameters, commands, hooks, events, config keys, defaults, model chains, type definitions, or file maps.
- **Delete, do not retire.** When a spec, guide, or idea is shipped, superseded, or abandoned and no longer describes current or proposed behavior, delete it; git keeps the history.

## Canonical Vocabulary

Domain language lives in [`CONTEXT.md`](../CONTEXT.md) — authoritative for terminology, not system behavior.

## Authority Order

Behavioral conflicts resolve: code → `rules/` → `adr/` → shipped `specs/` → `guides/` → `ideas/`. `references/` is evidence, never policy.

## Lifecycle Statuses

Specs use `draft` · `planned` · `shipped`. Ideas always use exact `Status: idea`. Supersede an ADR with a new ADR plus reciprocal `Supersedes` / `Superseded by` links; never edit ADR history.

## What This Harness Is

Panda Harness is a personal [Pi](https://github.com/mariozechner/pi-coding-agent) configuration repository: custom agents, runtime extensions, and a Nix-managed development environment. It is **not** a shared framework or general-purpose template. See the root [README](../README.md) for layout, setup, and checks.

### Extensions

Each extension lives in `extensions/<name>/` with a default-exported `index.ts` that receives `ExtensionAPI`. [`test/extensions.smoke.test.ts`](../test/extensions.smoke.test.ts) owns the discovery logic. [Extension READMEs](specs/extensions.md) follow one standard; [`extensions/CONVENTIONS.md`](../extensions/CONVENTIONS.md) owns the event and RPC contract.

Extensions grow through three tiers (never skip ahead):

1. **Flat directory** — `extensions/foo/index.ts` + siblings
2. **Structured** — `extensions/foo/index.ts` + `src/` + `test/`
3. **Package** — Re-export-only `index.ts`, implementation under `src/`, and a `package.json`

Vendored packages record upstream `repository` metadata in their `package.json`; their READMEs own provenance.

### Agent Modes

[`modes/README.md`](../modes/README.md) owns the mode set and prompt construction; [modes.md](specs/modes.md) is the shipped mode contract, and [orchistration.md](guides/orchistration.md) is the practical workflow guide.

## Specification Index

| Document | Purpose |
|----------|---------|
| [extensions.md](specs/extensions.md) | Extension README standard |
| [extension-model-usage.md](specs/extension-model-usage.md) | `tool_models.json` role schema for extension-owned LLM calls |
| [model-selection-and-fallback.md](specs/model-selection-and-fallback.md) | Model-chain parsing, profile filtering, and fallback behavior |
| [modes.md](specs/modes.md) | Agent modes design and switching behavior |
| [mode-prompt-parity.md](specs/mode-prompt-parity.md) | Upstream baseline and local mode prompt invariants |
| [mode-prompt-audit-checklist.md](specs/mode-prompt-audit-checklist.md) | Prompt audit procedure |
| [mode-scoped-subagent-delegation.md](specs/mode-scoped-subagent-delegation.md) | Mode-scoped subagent delegation policy |
| [subagent-tool-output-presentation.md](specs/subagent-tool-output-presentation.md) | Subagent tool-row presentation contract |
| [herdr-agent-graph-presentation.md](specs/herdr-agent-graph-presentation.md) | Hierarchy-first presentation for the Herdr agent-graph panel |
| [dynamic-agent-graph-expansion.md](specs/dynamic-agent-graph-expansion.md) | Awaited typed fanout, all-settled collection, persistence, and dynamic monitor |
| [agent-graph-bounded-feedback.md](specs/agent-graph-bounded-feedback.md) | Bounded feedback with durable runtime identity and partial synthesis |
| [agent-graph-yaml-invocation-gates.md](specs/agent-graph-yaml-invocation-gates.md) | Saved graph YAML, `$graph:<name>` invocation, and decision gates |

## Guides

- [orchistration.md](guides/orchistration.md) — choosing and running the Kua Fu or Fu Xi → Hou Tu orchestration workflow
- [agent-orchestration.md](guides/agent-orchestration.md) — role and delegation map across modes
- [agent-frontmatter.md](guides/agent-frontmatter.md) — authoring agent and mode frontmatter
- [tool-output-tui-rendering.md](guides/tool-output-tui-rendering.md) — Panda Harness standard for Pi tool and notification presentation
- [testing/README.md](guides/testing/README.md) — testing overview, with [unit](guides/testing/unit-test.md) and [integration](guides/testing/integration-test.md) conventions
