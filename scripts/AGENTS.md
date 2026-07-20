# scripts

## Purpose

Repo helper scripts used by install, packaging, sync, and maintenance flows.

## Ownership

This file owns `scripts/`.

## Local Contracts

- Scripts must be runnable from the repo root unless their header says otherwise.
- Do not add global installs or host-mutating setup as a default path; prefer Nix/project-scoped execution.
- Keep sync scripts explicit about temp directories, upstream source, and files intentionally ignored.
- Preserve executable semantics when editing shell scripts.
- Oh My OpenAgent reference archive updates run through `pnpm sync:oh-my-openagent-prompts`; verify with `pnpm check:oh-my-openagent-prompts`. The archive includes generated final prompts plus the raw upstream `skills/ulw-plan/` snapshot.

## Work Guidance

- Use the existing script language and style.
- For scripts called by docs or root commands, update the relevant AGENTS/docs reference when names or behavior change.
- Avoid adding new scripts when an existing root command or package script can cover the workflow.

## Verification

- For script behavior changes, run the script's dry-run/status mode if available.
- For syntax-only shell checks, prefer the narrowest available check in the current environment.

## Child DOX Index

No child `AGENTS.md` files. This file owns all files under `scripts/`.
