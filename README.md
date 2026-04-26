# Panda Harness

Panda Harness is this user's personal [Pi](https://github.com/mariozechner/pi-coding-agent) configuration repo.

It keeps three things in one place:

- personal Pi agents and extensions
- a reproducible Nix development shell
- a standard root-level testing flow for extensions

This repo stays **personal in scope**. It is not trying to become a shared framework or CI-heavy template right now.

## Quick start

### Install into `~/.pi/agent`

```bash
bash install.sh
```

### Load the dev shell

Prefer `direnv` over manually running `nix develop`.

```bash
direnv allow
direnv reload
```

### Install JavaScript dependencies

```bash
pnpm install
```

### Run the standard checks

```bash
pnpm test:extensions
pnpm lint:typecheck
```

## What is in this repo

| Path | Purpose |
| --- | --- |
| `agents/` | Custom Pi agent definitions |
| `extensions/` | Pi extensions and extension packages |
| `test/` | Root smoke harness and shared test fixtures/stubs |
| `docs/` | Human-facing design and testing notes |
| `scripts/` | Helper scripts for repo maintenance |

## Extension testing model

Panda Harness uses one root entrypoint for extension validation:

- `pnpm test:extensions`

That root flow combines:

1. existing extension-local tests where they already exist
2. root smoke coverage for top-level extension entrypoints

See `docs/testing/README.md` for the exact maintenance rules.

## Repo checks

- `pnpm test:extensions` — extension tests and smoke coverage
- `pnpm lint:typecheck` — root lint/typecheck plus package-local lint/typecheck where available

## Documentation split

- `README.md` — human-facing overview
- `AGENTS.md` — AI-facing maintenance rules and repo boundaries
- `docs/testing/README.md` — extension testing policy
- `docs/orchestration-flow.md` — orchestration design notes

## Local workflow preference

Use `direnv` as the default shell loader for this repo.

The flake is still the source of truth, but `direnv` should be the normal way to enter the development environment.

## Current boundaries

- no GitHub workflow automation
- no broad AI doc coverage enforcement
- prefer behavior-preserving extension changes
- allow only small localized refactors when needed to fit the standard test flow
