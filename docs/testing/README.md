# Panda Harness Testing

Two-tier test architecture: unit tests for isolated logic, integration tests for real pi runtime behavior.

## Test Tiers

| Tier | Location | Pi packages | What it validates | Command |
|------|----------|-------------|-------------------|---------|
| **Unit** | `extensions/*/test/` for extension-specific tests, `test/*.test.ts` for shared harness tests | Stubs (fake) | Extension logic in isolation | `pnpm test:extensions` |
| **Integration** | `test/integration/` | Real (via pi-test-harness) | Extensions in real pi runtime | `pnpm test:integration` |

```bash
pnpm test                # run both tiers
pnpm test:extensions     # unit tests only
pnpm test:integration    # integration tests only
```

## Vitest Workspace

Two vitest projects defined inline in `vitest.config.ts` using the `projects` array:

- **unit** — stubs `@mariozechner/*` via resolve aliases, includes `extensions/**/*.test.ts` + `test/**/*.test.ts`
- **integration** — real pi packages, includes `test/integration/**/*.test.ts`, 30s timeout

Rule: extension-specific unit tests stay next to their extension under `extensions/foo/test/`. Root `test/` holds shared harness tests, smoke coverage, fixtures, and stubs.

## Detailed Docs

- **[Unit Testing](unit-test.md)** — stubs, mock-pi, smoke harness, writing extension unit tests
- **[Integration Testing](integration-test.md)** — pi-test-harness, playbook DSL, mock tools/UI, event assertions

## install.sh Behavior

The test framework is intentionally excluded from `install.sh` symlinking. The allowlist only symlinks pi-runtime items (`agents/`, `docs/`, `mcp.json`, etc.) into `~/.pi/agent/`. Test infrastructure (`test/`, `vitest.config.ts`, `package.json`, `node_modules/`, etc.) stays in the repo only.
