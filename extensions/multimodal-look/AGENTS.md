## Purpose

Inspect one image with an isolated, profile-aware vision model through `look_at`.

## Ownership

- Owns image validation, vision routing/session creation, and result presentation.
- Profiles constrains model availability; the main session retains its model.

## Local Contracts

- Input MUST select exactly one local path or base64 image source.
- Local paths MUST resolve beneath the current working directory.
- Images MUST respect the 20 MiB limit and PNG/JPEG/WebP/GIF MIME allowlist.
- Vision sessions MUST have no tools, extensions, skills, templates, or context files.
- Routing MUST NOT change the main session model.
- Routing MUST resolve shared key `multimodal-look.inspect` through role `vision.inspect`; built-in, global, then project config precedence applies.
- The built-in `vision.inspect` chain MUST remain `gpt-5.5:medium,mimo-v2.5,kimi-k2.6,glm-4.6v,gpt-5-nano`.
- Current-model fallback requires declared image support; otherwise failure is explicit.
- Results MUST retain text findings and the original image block.

## Work Guidance

- [README](README.md) owns input grammar, shared routing configuration, and fallback notification behavior.
- Vision model selection MUST use the active registry rather than bypass profile filtering.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/multimodal-look/test`.
- [Result contract](test/result-contract.test.ts) and [rendering](test/render.test.ts) cover output preservation.

## Child DOX Index

- None; this document owns the entire subtree.
