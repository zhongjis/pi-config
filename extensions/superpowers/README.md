# superpowers

Vendored Superpowers skills adapted for this Pi harness. Opt-in via `/mode luban`.

## Upstream

- **Source:** https://github.com/obra/superpowers
- **Version:** 6.0.3
- **Commit:** 896224c
- **License:** MIT
- **Last synced:** 2026-06-26

## Sync

Use `scripts/sync-superpowers.sh` to track and update vendored skills.

```bash
scripts/sync-superpowers.sh status              # show pin vs upstream HEAD + drift
scripts/sync-superpowers.sh diff [<skill>]      # diff vendored vs pinned upstream
scripts/sync-superpowers.sh update --dry-run    # preview upcoming changes
scripts/sync-superpowers.sh update              # re-vendor to upstream HEAD
scripts/sync-superpowers.sh update --commit <sha>
```

Sync model: `upstream@<pinned> skills/ (minus ignore list) + overlay/files/* = skills/`; `index.ts` = mode-gated fork of upstream `.pi/extensions/superpowers.ts`.

Do not hand-edit `skills/` for Pi-specific divergences. Use `overlay/files/` for
local-only files (no upstream counterpart) and update `index.ts` for mode-gating changes.

## What It Does

- Bundles 14 upstream Superpowers skills under `skills/`.
- `index.ts` registers a `resources_discover` handler that injects bundled skills
  only when the latest persisted `agent-mode` entry is `luban`.
- Supports the `luban` mode registered by `extensions/modes`; crossing the Lu Ban
  boundary triggers runtime reload when available.
- No bootstrap prompt injection outside `/mode luban`.

## Commands

- `/mode luban` — Switch to Lu Ban mode (Superpowers skills active).

## Files Worth Reading

- `index.ts` — Registers `resources_discover` to conditionally inject `./skills`.
- `package.json` — Declares `pi.extensions` and `piVendor` metadata.
- `skills/using-superpowers/SKILL.md` — Upstream guardrail skill (verbatim).
- `skills/using-superpowers/references/pi-tools.md` — Pi-native tool mapping (local-only).
- `overlay/files/` — Local-only files (no upstream counterpart).

## Notes

- Skill directory names remain upstream-exact for easier sync.
- `brainstorming` may be shadowed by a global/user skill depending Pi skill load order.
