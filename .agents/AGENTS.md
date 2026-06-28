# .agents

## Purpose

Repo-local agent skills and source snapshots used to teach Pi-specific workflows.

## Ownership

This file owns `.agents/` except where a child `AGENTS.md` exists. Existing child docs keep ownership of their subtree.

## Local Contracts

- Skill directories under `.agents/skills/` are AI instruction assets, not runtime extension code.
- Do not edit mirrored upstream snapshots unless explicitly asked to refresh or patch that snapshot.
- Keep skill guidance source-grounded: cite local files or opened upstream sources instead of relying on memory.
- Preserve provenance in skill files when vendoring or adapting outside material.

## Work Guidance

- Prefer updating the specific skill directory that owns the behavior.
- For `pi-docs-playbook`, read its child `AGENTS.md` before touching that skill.
- Keep repo-specific skill instructions concise and operational; move long references into `references/`, `guides/`, or `source/` as appropriate.

## Verification

- For instruction-only edits, re-read the changed skill files and confirm linked paths resolve.
- If a skill includes scripts or generated artifacts, run the skill-local verification documented in that skill directory.

## Child DOX Index

| Path | Owner Doc | Scope |
|------|-----------|-------|
| `skills/pi-docs-playbook/` | `skills/pi-docs-playbook/AGENTS.md` | Pi documentation playbook skill, local navigation aids, and mirrored upstream source rules. |
| `skills/pi-docs-playbook/source/` | `skills/pi-docs-playbook/source/AGENTS.md` | Mirrored upstream pi source snapshot rules. |
