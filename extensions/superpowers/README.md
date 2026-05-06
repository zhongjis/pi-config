# superpowers

Vendored Superpowers skills adapted for this Pi harness, plus an opt-in `/mode luban` workflow (Lu Ban 鲁班 persona).

## Upstream

- **Source:** https://github.com/obra/superpowers
- **Version:** 5.1.0
- **Commit:** f2cbfbef
- **License:** MIT
- **Adapted:** Skills keep upstream names and workflow semantics, with minimal Pi-native tool mapping notes.

## What It Does

- Bundles 14 upstream Superpowers skills under `skills/`.
- Registers a `resources_discover` event handler in `index.ts` that injects the bundled skills directory into Pi at session start, so each `SKILL.md` is discoverable like a normal skill (`/skill:<name>`).
- Supports the local `luban` mode registered by `extensions/modes`.
- Keeps Superpowers opt-in: no automatic bootstrap prompt injection outside `/mode luban`.

## Commands

- `/mode luban` — Switch to Lu Ban mode (Superpowers skills active).

## Local Additions

- Maps upstream Claude-style tool references to Pi-native tools in `skills/using-superpowers/references/pi-tools.md`.
- Uses this repo's existing `Agent` and `Task*` tools instead of Weiping's `dispatch_agent` subprocess tool.
- Omits bootstrap injection; `extensions/modes` owns mode prompt injection.

## Notes

- Skill names remain upstream-exact for easier sync.
- `brainstorming` may be shadowed by an existing global/user skill depending Pi skill load order.

## Files Worth Reading

- `index.ts` — Registers `resources_discover` to inject `./skills` into Pi.
- `package.json` — Declares `pi.extensions`, `pi.skills`, and vendoring metadata.
- `skills/using-superpowers/SKILL.md` — Upstream guardrail skill, patched for Pi mapping.
- `skills/using-superpowers/references/pi-tools.md` — Pi-native tool mapping.
