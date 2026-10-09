# Panda Harness

Panda Harness is this user's personal [Pi](https://github.com/mariozechner/pi-coding-agent) configuration repo.

It keeps three things in one place:

- personal Pi agents, modes, and extensions
- a reproducible Nix development shell
- a standard root-level testing flow for extensions

This repo stays **personal in scope**. It is not a shared framework or CI-heavy template.

## Quick start

### Install into `~/.pi/agent`

```bash
bash install.sh
```

### Load the dev shell

Use `direnv` as the normal way to enter the development environment; the flake remains the source of truth.

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
pnpm test:extensions   # extension tests plus root smoke coverage
pnpm lint:typecheck    # root and package-local lint/typecheck
```

[`package.json`](package.json) owns the full script list; [the testing guide](docs/guides/testing/README.md) owns the test layout and maintenance rules.

## Where things live

- [`AGENTS.md`](AGENTS.md) — AI-facing maintenance rules; its Child DOX Index maps every top-level directory to its owning doc.
- [`docs/README.md`](docs/README.md) — human-facing specs, guides, ADRs, and ideas.
- [`GLOSSARY-MAP.md`](GLOSSARY-MAP.md) — domain vocabulary.

## Boundaries

- no GitHub workflow automation
- no broad AI doc coverage enforcement
- prefer behavior-preserving extension changes
- allow only small localized refactors when needed to fit the standard test flow
