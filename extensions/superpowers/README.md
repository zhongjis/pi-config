# superpowers

Vendored Superpowers skills adapted for this Pi harness. Opt-in via `/mode luban`.

## Upstream

- **Source:** https://github.com/obra/superpowers
- **Version:** 5.1.0
- **Commit:** f2cbfbef
- **License:** MIT
- **Last synced:** 2026-05-08

## Sync

Use `scripts/sync-superpowers.sh` to track and update vendored skills.

```bash
scripts/sync-superpowers.sh status              # show pin vs upstream HEAD + drift
scripts/sync-superpowers.sh diff [<skill>]      # diff vendored vs pinned upstream
scripts/sync-superpowers.sh update --dry-run    # preview upcoming changes
scripts/sync-superpowers.sh update              # re-vendor to upstream HEAD
scripts/sync-superpowers.sh update --commit <sha>
```

Sync model: `upstream@<pinned> + overlay/pi-adaptations.patch + overlay/files/ = skills/`.

Do not hand-edit `skills/` for Pi-specific divergences. Edit upstream content or
the overlay instead, then regenerate:

```bash
# after modifying skills/ with intentional local changes:
diff -urN /tmp/superpowers-upstream/skills extensions/superpowers/skills \
  -x codex-tools.md -x copilot-tools.md -x gemini-tools.md \
  | sed -E 's|^--- /tmp/superpowers-upstream/skills/|--- a/|; s|^\+\+\+ extensions/superpowers/skills/|+++ b/|' \
  > extensions/superpowers/overlay/pi-adaptations.patch
```

`sync-superpowers.sh status` verifies vendored tree matches
`upstream@pinned + overlay` and fails loud on unexpected drift.

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
- `skills/using-superpowers/SKILL.md` — Upstream guardrail skill, patched for Pi.
- `skills/using-superpowers/references/pi-tools.md` — Pi-native tool mapping (local-only).
- `overlay/pi-adaptations.patch` — All intentional text patches vs upstream.
- `overlay/files/` — Local-only files (no upstream counterpart).

## Notes

- Skill directory names remain upstream-exact for easier sync.
- `brainstorming` may be shadowed by a global/user skill depending Pi skill load order.
