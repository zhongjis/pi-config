# pm-marketplace — Agent Guide

Vendored from https://github.com/phuryn/pm-skills. Opt-in via `/mode shennong`.
See `README.md` for user-facing docs and `AGENTS.md` (this file) for maintainer rules.

## Ownership

`index.ts` is a local mode-gated wrapper. `pm-skills/` is vendored — do not hand-edit.

Pinned SHA lives in `package.json` → `piVendor.commit` (and `pm-skills/PROVENANCE.md`).

## Local Tweaks

| File | What |
|------|------|
| `index.ts` | Mode-gated wrapper; `resources_discover` + 32 `/pm:*` command registration + background update-check |
| Command registration logic | Dynamic discovery of `pm-skills/*/commands/` dirs; registers each as a `/pm:*` command |

## Re-vendoring

Use the `pi-extension-vendoring` / `skill-maintainer` skill. Steps:
1. Re-clone upstream at new SHA.
1. Re-clone upstream at new SHA.
2. Re-copy the 7 `skills/` and `commands/` subtrees into `pm-skills/`.
3. Bump `piVendor.commit` in `package.json` and `pm-skills/PROVENANCE.md`.
4. Run `pnpm lint:typecheck` and the extension tests.

Never run `git clone` inside this repo worktree. Use `/tmp`.

## Ask first

- Bumping to a major upstream version with migration notes.
- Adding or dropping plugin subdirectories.

## Never

- Do not hand-edit `pm-skills/` for Pi-specific content.
- Do not add context injection or message mutation to `index.ts`.

## References

- `README.md` — user-facing
- `pm-skills/PROVENANCE.md` — vendoring record
- `pm-skills/LICENSE` — upstream MIT license

## Child DOX Index

No child `AGENTS.md` files. This file owns all files under `extensions/pm-marketplace/`, including `pm-skills/`.
