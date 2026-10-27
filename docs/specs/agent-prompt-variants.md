# Agent Prompt Variants

Status: shipped

## Problem Statement

Mode Agents can ship model-family prompt variants, but Subagents cannot. A Subagent definition is one Markdown file whose body is used for every model in its fallback chain, even though most chains mix families (for example a Claude model followed by a GPT model). Authors cannot tune a Subagent prompt for GPT without degrading it for Claude, and a runtime fallback to another family keeps running the prompt written for the first family.

The surrounding Subagent surface also carries machinery this harness does not use: stock agents that silently stand in for unknown agent types, an `append` prompt mode, a `/agents` menu that writes flat definition files, and a setting that only hides the stock agents. Each of these either hides failures or conflicts with directory-form definitions.

## Solution

A Subagent may be defined as a directory, `<name>/default.md` plus optional `<name>/gpt.md` and `<name>/gemini.md`, with the same meaning as Mode Agent variants. A flat `<name>.md` keeps working as a default-only definition. Mode Agents rename their default file from `mode.md` to `default.md`, so both share one convention.

The prompt variant follows the model actually running the child: it is chosen at spawn and re-chosen before every run, so a runtime fallback across families switches prompts. Definition loading always lands on a valid prompt when one exists, warning the user about every invalid candidate it skipped.

The delegation allowlist becomes the only gate on an `agent` call: an unknown or unloaded type is denied like a disallowed one. Stock agents, `append`, menu write paths, and the stock-agent setting are removed.

## User Stories

1. As an agent author, I want to define a Subagent as `<name>/default.md`, so that its prompt can gain model-family variants.
2. As an agent author, I want `<name>/default.md` to carry the frontmatter and default body, so that one file owns the definition's access contract.
3. As an agent author, I want an optional `<name>/gpt.md` body that replaces the default body for GPT-family models, so that I can write a self-contained GPT prompt.
4. As an agent author, I want an optional `<name>/gemini.md` overlay injected before the first `<critical>` block for Gemini-family models, so that Gemini corrections match Mode Agent behavior.
5. As an agent author, I want a missing or empty `gpt.md` or `gemini.md` to fall back to the default body, so that variants stay optional.
6. As an agent author, I want my existing flat `<name>.md` files to keep working unchanged, so that migration is opt-in.
7. As an agent author, I want a directory definition to win silently over a flat file of the same name in the same location, so that a leftover flat file does not shadow my migration.
8. As an agent author, I want other files in an agent directory (such as `AGENTS.md` or notes) to be ignored, so that the directory can hold maintenance material.
9. As an agent author, I want directory definitions to work in the global, workspace, and project agent locations, so that every location supports variants.
10. As a user, I want an invalid `<name>/default.md` to fall back to `<name>.md` in the same location, so that a typo does not remove the agent.
11. As a user, I want an invalid definition in a higher-priority location to fall back to lower-priority locations, so that a broken project override leaves the global agent usable.
12. As a user, I want a warning for every invalid candidate skipped, naming the file, the problem, and the definition actually used, so that I know which prompt is running.
13. As a user, I want a warning when no valid definition of a name remains, so that I know why the agent is unavailable.
14. As a user, I want each warning shown once per message rather than on every reload, so that diagnostics do not flood the session.
15. As a user, I want a Subagent's variant chosen from its own resolved model, so that a GPT child of a Claude parent receives its GPT prompt.
16. As a user, I want a Subagent with no configured model to use the parent's model family, so that inherited models still choose a fitting variant.
17. As a user, I want the variant re-chosen when runtime model fallback moves a child to another family, so that the child never runs a prompt written for a model it is no longer using.
18. As a user, I want the variant re-chosen on every run of a child, so that later runs do not revert to the spawn-time family.
19. As a mode maintainer, I want each mode's default prompt file named `default.md`, so that modes and agents share one variant convention.
20. As a mode maintainer, I want a mode without `gpt.md` or `gemini.md` to use its `default.md` body for that family, so that variants stay optional.
21. As a maintainer, I want one shared prompt-variant helper used by modes and Subagents, so that variant selection and overlay placement cannot drift between them.
22. As a delegating agent, I want an `agent` call naming an unknown, disabled, or unloaded type to be denied with the list of types I may use, so that a typo never runs a different agent.
23. As a user without an active mode, I want delegation limited to loaded agents, so that unrestricted delegation still cannot name a nonexistent agent.
24. As a user, I want no stock agents registered, so that only agents I defined are callable.
25. As a user, I want the `/agents` menu to list agents, show definitions, and show running agents without writing files, so that it never creates flat files that shadow directory definitions.
26. As a maintainer, I want the `append` prompt mode removed, so that no unused prompt-composition path remains.
27. As a maintainer, I want the stock-agent setting removed from settings, the settings menu, and the shipped configuration, so that no dead configuration remains.
28. As a graph author, I want the internal graph classifier agent to keep working, so that decision gates are unaffected.
29. As a maintainer, I want the Taishang definition migrated to the directory form unchanged, so that the new loading path runs on a real agent.
30. As a maintainer, I want agent-definition lint coverage to include directory definitions and renamed mode files, so that the fleet check does not silently lose coverage.

## Implementation Decisions

- Family detection is unchanged and shared: a model id containing `gpt` is the GPT family; a `google` provider or an id containing `gemini` is the Gemini family; every other model, including Claude, is the default family.
- A new shared prompt-variant module in the extension library owns the variant directory layout and selection. It reads a variant directory (default file content and path, plus non-empty trimmed `gpt` and `gemini` bodies), selects a body for a family (GPT replaces, Gemini overlays, otherwise default), and owns overlay injection, moved unchanged from the modes extension. It does not parse frontmatter; callers parse the default content with the existing shared agent frontmatter parser and keep their own error handling.
- Mode Agents load `default.md` through the shared module. The mode configuration no longer carries a separate overlay field; its body is already the selected variant. The mode-and-family configuration cache is unchanged.
- `mode.md` is renamed to `default.md` for every mode with no compatibility path. A mode directory is active when it contains `default.md`.
- Subagent definitions store the default body as their system prompt plus optional stored variants. Variants are read at definition load, not at spawn.
- Definition resolution per agent name walks candidates in priority order — project directory, project flat file, workspace directory, workspace flat file, global directory, global flat file — and uses the first valid candidate. Each invalid candidate skipped yields a warning naming what was used instead; exhausting all candidates yields a "no valid definition" warning. Warnings use the existing deduplicated session notification path for definition diagnostics.
- The Subagent runner builds the child prompt for a model family. The initial prompt uses the spawn model; a `before_agent_start` handler in the runner's trusted fallback extension sets the system prompt's custom-prompt section from the current model before every run. It must set the custom-prompt section, not return a whole system prompt, so project context and skills sections survive. Rationale: Pi evaluates the system-prompt override only at resource reload, while every run starts from base prompt options and passes through `before_agent_start`.
- The delegation allowlist is the only gate on `agent` calls. Without an active mode, permitted types are all loaded, enabled types; with an active mode, they are the mode's rules resolved against loaded types. The requested type is canonicalized against loaded types; any type outside the permitted set is denied with the existing denial result. No fallback agent is substituted.
- Stock agents (`general-purpose`, `Explore`, `Plan`) are removed, along with the unknown-type fallback configuration and fallback note.
- The `append` prompt mode is removed from the frontmatter schema and prompt construction. Prompt modes are `replace` and `system_instructions`.
- The `/agents` menu is read-only: list, view definition, running agents. Create, generate, edit, delete, reset, eject, and enable/disable paths are removed.
- The stock-agent visibility setting is removed from settings parsing, the settings menu, the shipped `subagents.json`, and recorded user preferences.
- The internal graph classifier agent stays on the flat, default-only built-in loader.

## Testing Decisions

- Tests exercise external behavior at the highest existing seams: definition loading from a filesystem fixture, mode configuration loading, the pure prompt-variant functions, the runner's per-run prompt hook, and the delegation policy resolver.
- No test asserts literal prompt wording or cross-variant prompt parity; fixtures use placeholder bodies.
- Prompt-variant module: GPT replacement, Gemini overlay placement (moved from existing modes overlay tests), default passthrough, missing and empty variants.
- Mode configuration loading: `default.md` load and each family's selection, following existing mode config-loader tests.
- Subagent definition loading: directory form, directory wins over flat file, invalid directory falls back to flat file with a warning, invalid project definition falls back to a lower-priority location, all-invalid yields a warning and no agent, non-variant files ignored. Prior art: existing custom-agent loader tests.
- Runner per-run hook: a GPT-family model sets the custom-prompt section to the GPT body; a default-family model sets the default body.
- Delegation: unknown type denied with and without an active mode; loaded type allowed without a mode. Prior art: existing delegation-policy tests.
- The agent-definition golden lint scans flat agent files and `*/default.md` in agents and modes, choosing the parse kind by root folder.

## Out of Scope

- Authoring any `gpt.md` or `gemini.md` content for Subagents.
- Migrating Subagents other than Taishang.
- Changing family detection rules, including any separate Claude family.
- Deprecating or removing Gemini support.
- Re-choosing the inherited parent prompt for Subagents (removed with `append`).

## Further Notes

- A flat file in a higher-priority location still fully overrides a directory definition in a lower-priority location; that is the existing location precedence.
