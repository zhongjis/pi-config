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
- Blocking model-callable UI tools MUST emit `user-prompted` before their first prompt; durable waiting state MUST persist separately.
- Vendored changes MUST preserve provenance and LICENSE; local deltas belong with the owning extension's documentation.
- `thinking-steps` MUST preserve native assistant Markdown transformers (including Mermaid) and streaming state while retaining its custom thinking display.
- ULW is intentionally high-rigor opt-in: `ulw/prompts/gpt.md` MUST preserve automatic planning, deep parallel research, strict verification, and scoped self-correction under active mode policy; GPT-specific refinements do not change the default variant.
- ULW GPT scenario evidence MUST follow distinct failure modes; combinations require concrete interaction risks. Mocked results prove caller handling only; existing evidence MAY serve multiple scenarios without bespoke reporting.

## Work Guidance

- Extension implementation work MUST start with the installed [pi-extensions router](../.agents/skills/pi-extensions/SKILL.md).
- Vendoring work SHOULD use [pi-extension-vendoring](../.agents/skills/pi-extension-vendoring/SKILL.md).
- Presentation work SHOULD use [pi-tool-output-presentation](../.agents/skills/pi-tool-output-presentation/SKILL.md).

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
- [init](init/AGENTS.md) — documentation initialization prompts.
- [pm-marketplace](pm-marketplace/AGENTS.md) — mode-gated PM resource runtime.
- [herdr-btw](herdr-btw/AGENTS.md) — vendored `/btw` Herdr side-thread launch and merge.
