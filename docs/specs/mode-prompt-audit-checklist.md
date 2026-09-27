# Mode Prompt Audit Checklist

Status: shipped

Purpose: future edits to `modes/<mode>/{mode,gpt,gemini}.md`. Target behavior parity where applicable, not exact upstream copies.

## Scope Guardrails

- In scope: existing Kuafu/Fuxi/Houtu default, GPT, and Gemini prompt bodies.
- Out of scope: new prompt families, model-chain edits, provider edits, auth edits, registry edits, and new model-chain routing.
- Do not claim local prompts are exact upstream copies.
- Do not edit prompt, test, or code files unless the active task explicitly includes them.

## Construction Reference

Use [mode-prompt-parity.md](mode-prompt-parity.md) as the single source for family construction semantics, current file matrix, and local invariants. Audit the final injected prompt for each affected family, not just the source files.

## Upstream Provenance Rule

Before prompt edits, record:

- upstream repo URL;
- exact upstream commit hash;
- inspected upstream paths;
- missing-path or negative evidence when a global prompt/profile is absent;
- local adaptation source and Pi-native tool mapping.

Use [mode-prompt-parity.md](mode-prompt-parity.md) as the provenance baseline. Preserve behavior parity and Pi tool adaptation; do not present local prompts as exact upstream copies.

## Parity Review Checklist

For each affected mode family:

- **Behavior parity:** compare final local behavior against upstream intent and local invariants; target parity where applicable, not exact copy.
- **Pi tool adaptation:** verify upstream tool names and workflows are mapped to Pi tools, agents, task tracking, CodeGraph, LSP, read/rg/fd, and verification requirements.
- **Scope guardrails:** confirm no new families, model-chain edits, provider/auth/registry edits, unsupported prompt families, or unrelated cleanup slipped in.
- **Rendered prompt checks:** review the final injected prompt for default/GPT/Gemini behavior, including stale-block stripping and overlay/replacement semantics.
- **Tests/typechecks:** run targeted Vitest for mode prompt construction and rendered prompt behavior; run `pnpm exec tsc --noEmit -p tsconfig.json` when docs links/types should be verified.
