# Mode Prompt Audit Checklist

Purpose: future edits to `modes/<mode>/{mode,gpt,gemini}.md`. Target behavior parity where applicable, not exact upstream copies.

## Scope Guardrails

- In scope: existing Kuafu/Fuxi/Houtu default, GPT, and Gemini prompt bodies.
- Out of scope: new prompt families, model-chain edits, provider edits, auth edits, registry edits, and new model-chain routing.
- Do not claim local prompts are exact upstream copies.
- Do not edit prompt, test, or code files unless the active task explicitly includes them.

## Construction Semantics

- Default family uses `mode.md` frontmatter and body.
- GPT family uses `gpt.md` as a body-only replacement when present. It retains parsed `mode.md` frontmatter and must be self-contained. A mode without a `gpt.md` (Fu Xi) uses the default `mode.md` body for GPT-family runs.
- Gemini family uses `gemini.md` as a body-only corrective overlay on the default `mode.md` body, not as a replacement.
- Active mode prompt markers strip stale mode blocks before injecting the resolved prompt.
- Review the final injected prompt for each affected family. Source-file review alone is insufficient.

## Current File Matrix

| Mode | `mode.md` | `gpt.md` | `gemini.md` |
|---|---:|---:|---:|
| kuafu | Yes | Yes | Yes |
| fuxi | Yes | — (inherits default) | Yes |
| houtu | Yes | Yes | Yes |

## Upstream Provenance Rule

Before prompt edits, record:

- upstream repo URL;
- exact upstream commit hash;
- inspected upstream paths;
- missing-path or negative evidence when a global prompt/profile is absent;
- local adaptation source and Pi-native tool mapping.

Use `docs/specs/mode-prompt-parity.md` as the current provenance baseline. Preserve behavior parity and Pi tool adaptation; do not present local prompts as exact upstream copies.

## Parity Review Checklist

For each affected mode family:

- **Behavior parity:** compare final local behavior against upstream intent and local invariants; target parity where applicable, not exact copy.
- **Pi tool adaptation:** verify upstream tool names and workflows are mapped to Pi tools, agents, task tracking, CodeGraph, LSP, read/rg/fd, and verification requirements.
- **Scope guardrails:** confirm no new families, model-chain edits, provider/auth/registry edits, unsupported prompt families, or unrelated cleanup slipped in.
- **Rendered prompt checks:** review the final injected prompt for default/GPT/Gemini behavior, including stale-block stripping and overlay/replacement semantics.
- **Tests/typechecks:** run targeted Vitest for mode prompt construction and rendered prompt behavior; run `pnpm exec tsc --noEmit -p tsconfig.json` when docs links/types should be verified.
