# Mode Prompt Audit Checklist

Purpose: future edits to `modes/<mode>/{mode,gpt,gemini}.md`. Target behavior parity where applicable, not exact upstream copies.

## Scope Guardrails

- In scope: existing Kuafu/Fuxi/Houtu/Luban default, GPT, and Gemini prompt bodies.
- Out of scope: new prompt families, model-chain edits, provider edits, auth edits, registry edits, and new model-chain routing.
- Do not claim local prompts are exact upstream copies.
- Do not claim Luban has upstream agent parity.
- Do not edit prompt, test, or code files unless the active task explicitly includes them.

## Construction Semantics

- Default family uses `mode.md` frontmatter and body.
- GPT family uses `gpt.md` as a body-only replacement. It retains parsed `mode.md` frontmatter and must be self-contained.
- Gemini family uses `gemini.md` as a body-only corrective overlay on the default `mode.md` body, not as a replacement.
- Active mode prompt markers strip stale mode blocks before injecting the resolved prompt.
- Review the final injected prompt for each affected family. Source-file review alone is insufficient.

## Current File Matrix

| Mode | `mode.md` | `gpt.md` | `gemini.md` |
|---|---:|---:|---:|
| kuafu | Yes | Yes | Yes |
| fuxi | Yes | Yes | Yes |
| houtu | Yes | Yes | Yes |
| luban | Yes | Yes | Yes |

## Upstream Provenance Rule

Before prompt edits, record:

- upstream repo URL;
- exact upstream commit hash;
- inspected upstream paths;
- missing-path or negative evidence when a global prompt/profile is absent;
- local adaptation source and Pi-native tool mapping.

Use `docs/specs/mode-prompt-parity.md` as the current provenance baseline. Preserve behavior parity and Pi tool adaptation; do not present local prompts as exact upstream copies.

## Luban / Superpowers Finding

No explicit global agent profile found; local Luban grounded in `using-superpowers` plus workflow skills.

Details from current parity evidence:

- Superpowers source: `obra/superpowers` `skills/` at commit `896224c4b1879920ab573417e68fd51d2ccc9072`.
- Task-specific embedded prompts exist, but they are not a global Superpowers agent profile.
- Local Luban behavior comes from `modes/luban/skills/using-superpowers/SKILL.md` and workflow skills such as brainstorming, writing plans, subagent-driven development, executing plans, dispatching parallel agents, and verification-before-completion.

## Parity Review Checklist

For each affected mode family:

- **Behavior parity:** compare final local behavior against upstream intent and local invariants; target parity where applicable, not exact copy.
- **Pi tool adaptation:** verify upstream tool names and workflows are mapped to Pi tools, agents, task tracking, CodeGraph, LSP, read/rg/fd, and verification requirements.
- **Scope guardrails:** confirm no new families, model-chain edits, provider/auth/registry edits, unsupported prompt families, or unrelated cleanup slipped in.
- **Rendered prompt checks:** review the final injected prompt for default/GPT/Gemini behavior, including stale-block stripping and overlay/replacement semantics.
- **Tests/typechecks:** run targeted Vitest for mode prompt construction and rendered prompt behavior; run `pnpm exec tsc --noEmit -p tsconfig.json` when docs links/types should be verified.
