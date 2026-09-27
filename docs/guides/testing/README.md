# Panda Harness Testing

Three Vitest projects: isolated unit tests, real-runtime integration tests, and subagents-e2e tests.

## Test Tiers

| Project | Location | Pi packages | What it validates | Command |
|---------|----------|-------------|-------------------|---------|
| **unit** | `extensions/*/test/`, `test/*.test.ts` | Stubs | Extension logic and shared harness tests | `pnpm test:extensions` |
| **integration** | `test/integration/` | Real | Extensions in the real Pi runtime | `pnpm test:integration` |
| **subagents-e2e** | `extensions/subagents/test/**/*e2e*.test.ts` | Real | Subagents end-to-end behavior | `pnpm exec vitest run --project subagents-e2e` |

```bash
pnpm test                # all configured projects
pnpm test:extensions     # unit only
pnpm test:integration    # integration only
pnpm exec vitest run --project subagents-e2e  # subagents-e2e only
```

## Vitest Workspace

Three Vitest projects are defined in `vitest.config.ts`:

- **unit** — stub aliases for Pi packages; excludes integration and subagents-e2e tests.
- **integration** — real Pi packages; includes `test/integration/**/*.test.ts`, 30-second timeout.
- **subagents-e2e** — real Pi packages; includes `extensions/subagents/test/**/*e2e*.test.ts`, 30-second timeout. There is currently no dedicated package script for this project.

Rule: extension-specific unit tests stay next to their extension under `extensions/foo/test/`. Root `test/` holds shared harness tests, smoke coverage, fixtures, and stubs.

## Detailed Docs

- **[Unit Testing](unit-test.md)** — stubs, mock-pi, smoke harness, writing extension unit tests
- **[Integration Testing](integration-test.md)** — real-runtime faux-provider playbooks, mock tools/UI, and event assertions

## install.sh Behavior

The test framework stays in the repository. The top-level `install.sh` allowlist symlinks only runtime support items (`agents/`, `agent-graphs/`, `modes/`, `caveman.json`, `pi-herdr-btw.json`, `session-summary.json`, `subagents.json`, `tool_models.json`, `scripts/`, and `themes/`) into `~/.pi/agent/`. Test infrastructure (`test/`, `vitest.config.ts`, `package.json`, `node_modules/`) is not installed.
