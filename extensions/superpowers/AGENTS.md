# superpowers — Agent Guide

Vendored from https://github.com/obra/superpowers. Opt-in via `/mode luban`.
See `README.md` for user-facing docs and `AGENTS.md` (this file) for maintainer rules.

## Sync model

Vendored tree is derived, not hand-maintained:

```
upstream@<pinned-sha> skills/ (minus IGNORE list)
  + overlay/files/*
  = extensions/superpowers/skills/

index.ts = mode-gated fork of upstream .pi/extensions/superpowers.ts
```

Pinned SHA lives in `package.json` → `piVendor.commit`.

Use `scripts/sync-superpowers.sh {status|diff|update}`. See README for commands.

Never run `git clone` inside this repo worktree. The sync script uses `/tmp`.

## Local Tweaks

Intentional divergences from upstream. Preserve these on sync.

| File | What |
|------|------|
| `index.ts` | Mode-gated fork of upstream `.pi/extensions/superpowers.ts`; 5 lifecycle events; `piToolMapping` reads local file |
| `overlay/files/using-superpowers/references/pi-tools.md` | Local-only file overriding upstream's generic `pi-tools.md` with Pi-native tool mapping |

## Ignore list (upstream files NOT vendored)

Hardcoded in `scripts/sync-superpowers.sh` → `IGNORE_FROM_UPSTREAM`:

- `using-superpowers/references/codex-tools.md`
- `using-superpowers/references/copilot-tools.md`
- `using-superpowers/references/gemini-tools.md`

Rationale: this harness is Pi-only; other platform tool-mappings add noise and
would require us to manually keep per-agent references in sync.

## Adding a new local tweak

**For `index.ts` changes:**
1. Edit `index.ts` directly.
2. Record the divergence purpose in the Local Tweaks table above.

**For local-only files (no upstream counterpart):**
1. Place file under both `skills/<skill>/...` and `overlay/files/<skill>/...`.
2. Record it in Local Tweaks above.

**Never** hand-edit `skills/` for Pi-specific text patches — use `overlay/files/` or `index.ts`.

## Ask first

- Bumping to a major upstream version with migration notes.
- Any upstream change that touches `using-superpowers/SKILL.md` main body (Pi mapping is tied to its structure).

## Never

- Do not hand-edit `skills/` for Pi-specific content; use `overlay/files/` or `index.ts`.
- Do not replace the whole `skills/` tree from upstream without running the sync script.
- Do not vendor the codex/copilot/gemini reference files.

## References

- `README.md` — user-facing
- `scripts/sync-superpowers.sh` — sync tooling
- `overlay/files/` — source-of-truth local-only files
- `.agents/skills/pi-vendored-extension-sync/SKILL.md` — general sync skill

## Child DOX Index

No child `AGENTS.md` files. This file owns all files under `extensions/superpowers/`, including `skills/` and `overlay/`.
