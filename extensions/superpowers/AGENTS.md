# superpowers — Agent Guide

Vendored from https://github.com/obra/superpowers. Opt-in via `/mode luban`.
See `README.md` for user-facing docs and `AGENTS.md` (this file) for maintainer rules.

## Sync model

Vendored tree is derived, not hand-maintained:

```
upstream@<pinned-sha>  (minus IGNORE list)
  + overlay/pi-adaptations.patch
  + overlay/files/*
  = extensions/superpowers/skills/
```

Pinned SHA lives in `package.json` → `piVendor.commit`.

Use `scripts/sync-superpowers.sh {status|diff|update}`. See README for commands.

Never run `git clone` inside this repo worktree. The sync script uses `/tmp`.

## Local Tweaks

Intentional divergences from upstream. Preserve these on sync.

| File | What | Why |
|------|------|-----|
| every `skills/*/SKILL.md` | Frontmatter adds `adaptedFrom:` link to upstream path | Provenance tracking |
| `skills/using-superpowers/SKILL.md` | Description rewritten to "opt-in via Superpowers mode"; Claude/Copilot/Gemini platform sections replaced with single Pi tool-mapping reference | Pi treats Superpowers as mode-gated, not always-on; other platforms not relevant |
| `skills/using-superpowers/references/pi-tools.md` | **Local-only file** (no upstream equivalent) | Maps upstream Claude-Code tool names to Pi-native tools |
| `skills/dispatching-parallel-agents/SKILL.md` | `Task("...")` calls rewritten as `Agent({ subagent_type: "jintong", run_in_background: true })` | Pi uses `Agent` tool with subagent types, not generic `Task` |
| `skills/executing-plans/SKILL.md` | `TodoWrite` → `TaskCreate`/`TaskUpdate` | Pi uses `pi-tasks` DAG |
| `skills/subagent-driven-development/SKILL.md` | `TodoWrite` → pi-tasks; dot graph labels updated accordingly | Same |
| `skills/writing-skills/SKILL.md` | `TodoWrite` → pi-tasks; skill install paths rewritten to `~/.pi/agent/skills` and `extensions/<pkg>/skills` | Matches Pi skill discovery |
| `skills/writing-skills/persuasion-principles.md` | `TodoWrite` references replaced with task tracker / `TaskCreate`/`TaskUpdate` | Same |
| `skills/requesting-code-review/SKILL.md` | `Task tool (general-purpose)` → `Pi Agent with reviewer agent type` | Same as dispatch pattern |
| `skills/requesting-code-review/code-reviewer.md` | `Task tool (general-purpose):` → `Pi \`Agent\` tool:` | Prompt header |
| `skills/brainstorming/spec-document-reviewer-prompt.md` | Same header rewrite | Prompt header |
| `skills/subagent-driven-development/{implementer,spec-reviewer,code-quality-reviewer}-prompt.md` | Same header rewrite | Prompt header |
| `skills/writing-plans/plan-document-reviewer-prompt.md` | Same header rewrite | Prompt header |

All of the above are encoded in `overlay/pi-adaptations.patch` — do not apply
them by hand.

## Ignore list (upstream files NOT vendored)

Hardcoded in `scripts/sync-superpowers.sh` → `IGNORE_FROM_UPSTREAM`:

- `using-superpowers/references/codex-tools.md`
- `using-superpowers/references/copilot-tools.md`
- `using-superpowers/references/gemini-tools.md`

Rationale: this harness is Pi-only; other platform tool-mappings add noise and
would require us to manually keep per-agent references in sync.

## Adding a new local tweak

1. Edit `skills/<skill>/...` directly with the change.
2. Regenerate the overlay patch (see README → Sync).
3. Run `scripts/sync-superpowers.sh status` → must report "matches upstream@pinned + overlay".
4. Record the divergence in the Local Tweaks table above.

## Adding a new local-only file

1. Place it under both `skills/<skill>/...` and `overlay/files/<skill>/...`.
2. Do not add a diff hunk for it in `pi-adaptations.patch` (it is copy-only).
3. Record it in Local Tweaks above.

## Ask first

- Bumping to a major upstream version with migration notes.
- Any upstream change that touches `using-superpowers/SKILL.md` main body (Pi mapping is tied to its structure).
- Any upstream commit that conflicts with overlay patches (`patch` emits `.rej`).

## Never

- Do not hand-edit `skills/` for Pi-specific content without updating overlay.
- Do not replace the whole `skills/` tree from upstream without running the sync script.
- Do not vendor the codex/copilot/gemini reference files.

## References

- `README.md` — user-facing
- `scripts/sync-superpowers.sh` — sync tooling
- `overlay/pi-adaptations.patch` — source-of-truth patch
- `overlay/files/` — source-of-truth local-only files
- `.agents/skills/pi-vendored-extension-sync/SKILL.md` — general sync skill
