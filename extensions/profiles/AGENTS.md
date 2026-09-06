## Purpose

Constrain model availability to the active provider profile.

## Ownership

- Owns registry filtering, profile activation, journal persistence, and local offline guards.
- Agent/mode frontmatter owns model fallback chains; profiles filters their available providers.

## Local Contracts

- Activation precedence MUST remain CLI flag → session journal → environment → default.
- Explicit CLI selection MUST persist for resumed sessions.
- Registry filtering MUST apply consistently to model menus and subagent resolution.
- Activating a profile MUST replace an out-of-profile current model.
- Local profile MUST retain external-tool/delegation guards and offline prompt behavior.
- Profiles are hardcoded; no profile configuration file exists.

## Work Guidance

- [README](README.md) owns provider lists, profile fields, and frontmatter compatibility.
- Model assignments SHOULD stay in frontmatter, not duplicate profile-specific agent definitions.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/profiles/profiles.test.ts`.
- [Profile tests](profiles.test.ts) cover filtering, activation, persistence, and guards.

## Child DOX Index

- None; this document owns the entire subtree.
