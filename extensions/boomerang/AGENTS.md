# boomerang

Vendored from `https://github.com/nicobailon/pi-boomerang`.

## Local Tweaks

Intentional divergences from upstream. Preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Copied from upstream root `index.ts`; local forced-skill plumbing remains for `/boomerang:commit` | Repo loads extensions from `extensions/<name>/index.ts`; local shortcut needs boomerang task internals |
| `commit.ts` | Local-only `/boomerang:commit` registration and commit task builder | Separates local git commit addon from vendored upstream entrypoint |
| `index.test.ts`, `render.test.ts` | Copied from upstream root `index.test.ts`; local tests cover `/boomerang:commit`, `max` thinking across single/chain/restore flows, config-gated tool renderer wiring, and renderer parity/width cases | Root Vitest discovers `extensions/**/*.test.ts`; local shortcut, compatibility paths, and renderer need coverage |
| `render.ts` | Local-only renderer for the config-gated `boomerang` tool | Upstream tool existed without local TUI renderer; keeps presentation separate from execution |
| `README.md` | Rewritten in local concise extension README format and documents `/boomerang:commit` | Repo requires factual README with provenance, no install/marketing sections |
| `package.json`, `package-lock.json`, `vitest.config.ts`, `banner.png`, `CHANGELOG.md` | Not copied | Root project already supplies deps/test config; README records upstream version/commit |

## Sync Notes

- Last synced upstream version: `0.7.0`.
- Last synced upstream commit: `1a5985b2d92cfa84ce1f470d100d02b368711a91`.
- Upstream license: not declared.
- Required dependencies are already present in root `package.json`: `typebox`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`.

## Child DOX Index

No child `AGENTS.md` files. This file owns all files under `extensions/boomerang/`.
