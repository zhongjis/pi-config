// Provenance: DOX source marker is explicit; prompt wording is original, Pi-native, and intentionally concise.
export const INIT_DOX_TEMPLATE = `# /init-dox

Add or migrate AGENTS.md files to DOX. Docs/process only; no runtime, package, config, or toolchain changes unless user args explicitly request broader changes.

Source marker: agent0ai/dox@5cb5ba55bd1c0f7c1b31fe655fe36e2febb760d2 (MIT). Adopt as a documentation/process layer, not as a Pi extension or package.

## Usage

/init-dox                    # Add DOX contract/index to current repo docs
/init-dox <path-or-scope>    # Limit work when user gave a path/scope
/init-dox --broader-changes  # Only if user explicitly requested package/config/toolchain work

## Command Contract

- Read existing AGENTS.md files before edits. Start at repo root, then child docs along each target path.
- If AGENTS.md exists, use edit. If absent, use write. Never overwrite existing AGENTS.md with write.
- Use rg/fd for discovery; use CodeGraph/LSP when useful and available. Do not require unavailable tools.
- Do not edit package files, settings, lockfiles, build config, toolchain config, or extension registration unless user args explicitly request broader changes.
- Do not copy large upstream content. Keep wording local, operational, and concise.
- Do not duplicate parent instructions into child docs; child docs contain local deltas only.
- If ownership, conflicts, or destructive migrations are ambiguous, ask before overwrite or deletion.

## DOX Contract

- AGENTS.md files are binding work contracts for their subtrees.
- Before editing, identify target paths and read applicable chain: root AGENTS.md -> each child AGENTS.md on path -> nearest owning AGENTS.md.
- Nearest AGENTS.md controls local details. Parent docs still control wider rules; child docs must not weaken parent contracts.
- After meaningful changes to structure, ownership, workflows, contracts, verification, permissions, side effects, or durable user preferences, update nearest owning AGENTS.md plus affected parent/child index before finishing.
- Tiny behavior-neutral edits may leave docs unchanged, but still perform DOX pass and report docs intentionally unchanged.
- Keep docs current by deleting stale/conflicting guidance instead of explaining history.

## Child DOX Index

Every AGENTS.md that owns child docs needs a concise index. Root owns top-level child docs; each child owns only its local children.

Use this table shape when children exist:

| Path | Owner Doc | Scope |
|------|-----------|-------|
| child/ | child/AGENTS.md | Local rules and ownership boundary. |

Use this line when none exist:

No child AGENTS.md files. This file owns all files under this path.

## Workflow

1. Locate repo root and target scope. Preserve user args exactly.
2. Discover current docs with fd. Read root first, then child docs on each target path.
3. Classify current state:
   - no AGENTS.md: create root AGENTS.md with DOX contract plus child index if child docs are added.
   - older DOX markers: update source marker/contract in place; preserve valid local rules.
   - AGENTS.md not using DOX: migrate in place; keep useful local commands, hazards, ownership, and gotchas.
   - conflicts or ambiguous ownership: stop and ask which doc owns the path before overwriting.
4. Write root first. Add ## DOX Contract and ## Child DOX Index near top unless local layout already has better equivalent headings.
5. Add or update child docs only where ownership boundary or local rules justify them.
6. Review parent/child docs: remove duplicates, remove generic advice, validate commands/paths, trim prose.

## Output

Return:
  === init-dox Complete ===
  Mode: created root | migrated | updated | unchanged
  Files created: N
  Files updated: N
  Files unchanged: N
  Asked user: yes/no
  Notes: docs intentionally unchanged, blockers, or ownership questions
`;
