# Panda Harness — Documentation

Design notes, standards, and reference material for this Pi harness.

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

Some extensions are vendored from upstream repositories. These have a `package.json` with `repository` field pointing to the original source. Vendored extensions preserve upstream attribution and document adaptation notes in their README.

Current vendored extensions:
- `subagent` — from [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)
- `tasks` — from [tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks)
- `pi-web-access` — from [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access)

### Agent Modes

Three agent personas switch context and tool access:
- **Kua Fu 夸父** (build) — default, general-purpose implementation
- **Fu Xi 伏羲** (plan) — plan drafting with restricted tools
- **Hou Tu 后土** (execute) — plan execution after handoff

See [modes.md](modes.md) and [orchestration-flow.md](orchestration-flow.md) for details.

## Documentation Index

| Document | Purpose |
|----------|---------|
| [extensions.md](extensions.md) | Extension README standard — what every extension README must contain |
| [modes.md](modes.md) | Agent modes design and switching behavior |
| [orchestration-flow.md](orchestration-flow.md) | Planning-to-execution lifecycle |
| [testing/README.md](testing/README.md) | Extension testing policy and two-tier model |
| [testing/unit-test.md](testing/unit-test.md) | Unit test conventions |
| [testing/integration-test.md](testing/integration-test.md) | Integration test approach |

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

Note: `install.sh` skips `AGENTS.md`, `settings.json`, and `skills` — those are managed by Home Manager / Nix.
