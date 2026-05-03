# boomerang

Vendored from `https://github.com/nicobailon/pi-boomerang`.

## Local Tweaks

Intentional divergences from upstream. Preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Copied from upstream root `index.ts`; local forced-skill plumbing remains for `/boomerang:commit` | Repo loads extensions from `extensions/<name>/index.ts`; local shortcut needs boomerang task internals |
| `commit.ts` | Local-only `/boomerang:commit` registration and commit task builder | Separates local git commit addon from vendored upstream entrypoint |
| `index.test.ts` | Copied from upstream root `index.test.ts`; local tests cover `/boomerang:commit` | Root Vitest discovers `extensions/**/*.test.ts`; local shortcut needs coverage |
| `README.md` | Rewritten in local concise extension README format and documents `/boomerang:commit` | Repo requires factual README with provenance, no install/marketing sections |
| `package.json`, `package-lock.json`, `vitest.config.ts`, `banner.png`, `CHANGELOG.md` | Not copied | Root project already supplies deps/test config; README records upstream version/commit |

## Sync Notes

- Last synced upstream version: `0.6.5`.
- Last synced upstream commit: `ea543818f0d3b92bc427e179cfe75d0984553f36`.
- Upstream license: not declared.
- Required runtime deps are already present in root `package.json`: `typebox`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`.
