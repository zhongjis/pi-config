# agents

## Purpose

Custom subagent definitions loaded by Pi. Files combine YAML frontmatter with prompt bodies.

## Ownership

This file owns all `agents/*.md` definitions.

## Local Contracts

- Keep mythology naming consistent with existing agents.
- Frontmatter controls routing: `display_name`, `description`, `model`, `builtin_tools`, `extension_tools`, and `extensions` must match the agent's intended capability.
- Match tool access to role scope. Read-only recon agents must not receive mutating tools.
- Prompt bodies define behavioral contracts; keep output formats explicit when callers depend on them.

## Work Guidance

- Update the specific agent file when changing one agent's behavior.
- Preserve existing frontmatter keys unless intentionally changing runtime routing.
- When adding an agent, use one `agents/<name>.md` file and give it a unique, task-oriented description.
- Avoid broad prompt rewrites unless the agent role itself changes.

## Verification

- Re-read changed frontmatter and prompt body for internal consistency.
- No repo-local automated check validates agent markdown; if runtime behavior matters, test by launching that agent through the `Agent` tool.

## Child DOX Index

No child `AGENTS.md` files. This file owns every `agents/*.md` file.
