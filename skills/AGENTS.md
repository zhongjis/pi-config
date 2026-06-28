# skills

## Purpose

Repo-managed skills that complement globally/Nix-managed Pi skills.

## Ownership

This file owns `skills/`.

## Local Contracts

- `SKILL.md` is the entrypoint for each skill directory.
- Keep skill descriptions trigger-focused and specific; broad generic triggers cause wrong skill activation.
- Do not assume `install.sh` syncs this directory into live `~/.pi/agent/skills`; root AGENTS notes the Nix/Home Manager boundary.
- Preserve upstream provenance when adding or adapting a skill.

## Work Guidance

- Update the owning skill directory, not unrelated global skills.
- Keep long references in skill-local files and link them from `SKILL.md`.
- Use skill-maintenance workflows for upstream syncs instead of ad-hoc copies.

## Verification

- Re-read changed `SKILL.md` files for trigger accuracy and path references.
- No repo-local automated check validates skill activation.

## Child DOX Index

| Path | Owner Doc | Scope |
|------|-----------|-------|
| `multi-reviewer/` | this file | Multi-model PR review skill. |
