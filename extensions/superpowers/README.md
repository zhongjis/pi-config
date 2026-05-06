# superpowers

Vendored Superpowers skills adapted for this Pi harness, plus an opt-in `/mode superpowers` workflow.

## Upstream

- **Source:** https://github.com/obra/superpowers
- **Version:** 5.1.0
- **Commit:** f2cbfbef
- **License:** MIT
- **Adapted:** Skills keep upstream names and workflow semantics, with minimal Pi-native tool mapping notes.

## What It Does

- Ships the 14 upstream Superpowers skills under `skills/` for Pi package discovery.
- Supports the local `superpowers` mode registered by `extensions/modes`.
- Keeps Superpowers opt-in: no automatic bootstrap prompt injection outside `/mode superpowers`.

## Commands

- `/superpowers` — Show a short status/help message.
- `/mode superpowers` — Switch to Superpowers mode.
- `/mode sp` — Short alias for Superpowers mode.

## Local Additions

- Maps upstream Claude-style tool references to Pi-native tools in `skills/using-superpowers/references/pi-tools.md`.
- Uses this repo's existing `Agent` and `Task*` tools instead of Weiping's `dispatch_agent` subprocess tool.
- Omits bootstrap injection; `extensions/modes` owns mode prompt injection.

## Notes

- Skill names remain upstream-exact for easier sync.
- `brainstorming` may be shadowed by an existing global/user skill depending Pi skill load order.

## Files Worth Reading

- `index.ts` — Registers the `/superpowers` help command.
- `package.json` — Declares `pi.skills` and vendoring metadata.
- `skills/using-superpowers/SKILL.md` — Upstream guardrail skill, patched for Pi mapping.
- `skills/using-superpowers/references/pi-tools.md` — Pi-native tool mapping.
