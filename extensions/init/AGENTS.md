## Purpose

Dispatch Pi-native prompts for hierarchical AGENTS.md initialization and DOX migration.

## Ownership

- Owns command registration, hidden follow-up dispatch, and initialization templates.
- Generated repository documents remain owned by their target DOX hierarchy.

## Local Contracts

- Both commands MUST forward raw arguments and trigger the follow-up turn.
- Notifications MUST require UI; headless dispatch remains supported.
- DOX work MUST remain documentation-only unless the user explicitly authorizes broader changes.
- Scoped requests MUST constrain migration to the requested paths.
- Create-new initialization MUST read existing documents before regeneration.
- Root entrypoint remains a re-export shim; templates stay under source.

## Work Guidance

- [README](README.md) owns command grammar, depth/reset behavior, and provenance.
- Template edits MUST preserve the distinction between init-deep and DOX migration.
- DOX process attribution MUST remain intact; init-deep wording remains local/Pi-native.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/init/test/init.test.ts`.
- [Command/template tests](test/init.test.ts) cover arguments, dispatch, headless behavior, and scope contracts.

## Child DOX Index

- None; this document owns the entire subtree.
