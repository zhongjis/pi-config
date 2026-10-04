## Purpose

Maintain Panda Harness extension runtime code and cross-extension integration contracts.

## Ownership

- This parent owns shared conventions, loose files, and every extension subtree not delegated below.
- Indexed children own their local runtime, tests, and documentation; root retains installation and repository tooling.

## Local Contracts

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. NEVER and AVOID mean MUST NOT and SHOULD NOT respectively.
</system-conventions>

- You MUST preserve behavior across localized refactors and extension boundaries.
- You MUST follow [event/RPC conventions](CONVENTIONS.md) for channel names, envelopes, and listener cleanup.
- [Fast](fast/README.md) owns interactive command/status telemetry; [lib](lib/README.md#fast-request-helpers), [modes](modes/AGENTS.md), and [subagents](subagents/AGENTS.md) own recipes and policy contracts.
- Explicit `/fast` is session-wide: the latest user `fast-policy` entry, including off, survives history navigation, compaction, reload, and reopening the same session. Unsupported models leave it saved but inactive; mode/model/fallback defaults MUST NOT override it. New sessions use configured defaults.
- Vendored changes MUST preserve provenance and LICENSE; local deltas belong with the owning extension's documentation.
- Extension docs MUST follow the [README standard](../docs/specs/extensions.md): current state only, linking to registration code instead of copying inventories. `## Local Tweaks` sections list current upstream divergences, not change history.
- `thinking-steps` MUST preserve native assistant Markdown transformers (including Mermaid) and streaming state while retaining its custom thinking display. Messages without visible thinking MUST remain silent, without placeholder panels or extra spacing; real and redacted thinking remain visible.

## Work Guidance

- Extension implementation work MUST start with the installed [pi-extensions router](../.agents/skills/pi-extensions/SKILL.md).
- Presentation work SHOULD use [panda-harness-tui-standard](../.agents/skills/panda-harness-tui-standard/SKILL.md).

## Verification

- Tests MUST protect mechanics and contracts, not prompt prose or mutable personal model choices; controlled string fixtures MAY exercise those contracts.

- From repository root: `pnpm test:extensions` runs shared unit coverage.
- Focused checks: `pnpm exec vitest run --project unit <path>`; use an existing test file or directory.
- [Root Vitest config](../vitest.config.ts) owns project selection and exclusions; [package scripts](../package.json) own common commands.

## Child DOX Index

- [lib](lib/AGENTS.md) — shared utilities and RPC primitives.
- [subagents](subagents/AGENTS.md) — isolated agent lifecycle and supervision.
- [tasks](tasks/AGENTS.md) — persistent task state and dependency management.
- [goal](goal/AGENTS.md) — goal continuation and accounting.
- [lsp](lsp/AGENTS.md) — language-server configuration and leases.
- [codegraph](codegraph/AGENTS.md) — indexed-code subprocess tools.
- [modes](modes/AGENTS.md) — mode runtime and planning approval.
- [handoff](handoff/AGENTS.md) — context transfer and bridge teardown.
- [smart-tool-guards](smart-tool-guards/AGENTS.md) — guarded native bash authorization.
- [session-local](session-local/AGENTS.md) — Agent-tree virtual storage.
- [github-fs](github-fs/AGENTS.md) — read-only GitHub views and account-scoped caching.
- [qol](qol/AGENTS.md) — shared footer, session UI, and write presentation.
- [profiles](profiles/AGENTS.md) — provider registry filtering and activation precedence.
- [multimodal-look](multimodal-look/AGENTS.md) — isolated vision inspection.
- [imagegen](imagegen/AGENTS.md) — vendored image generation, `/img` workflows and local browser studio.
- [init](init/AGENTS.md) — documentation initialization prompts.
- [herdr-btw](herdr-btw/AGENTS.md) — vendored `/btw` Herdr side-thread launch and merge.
- [recap](recap/AGENTS.md) — vendored session-recap lifecycle and model-chain fallback.
- [inline-skills](inline-skills/AGENTS.md) — vendored `$skill:`/`$graph:` tokens and session-bound graph authorization.
- [ulw](ulw/AGENTS.md) — opt-in ultrawork prompt injection and GPT variant contracts.
