# imagegen

Generate images through Pi's configured CLIProxyAPI provider, with a local browser studio. The official ChatGPT-login route resolves Pi OAuth credentials but remains subject to OpenAI's image authorization.

## Upstream

- **Source:** [Jon-Vii/pi-imagegen](https://github.com/Jon-Vii/pi-imagegen)
- **Version:** 0.2.0, pinned commit `2ca63486547fdf780e84b105548783bc9de1e5c3`
- **License:** MIT declaration; see [UPSTREAM-LICENSE.md](UPSTREAM-LICENSE.md) for exact evidence and absent license artifact.
- **Adapted:** `index.ts` discovery, `@earendil-works/*` imports, supported notifications, studio access checks, direct Images API transport and provider/model selection. [AGENTS.md](AGENTS.md#local-tweaks) owns the sync checklist.

## What It Does

- Returns image attachments and saves images, metadata and indexed history locally.
- Preserves batches, style presets, reference images, sketch references and image comparison.
- Uses `/images/generations` for prompts and `/images/edits` for references; there is no chat dispatcher.
- Accepts `gpt-image-2`, `gpt-image-2.5` and `gpt-image-2.5-sunburst`; the default is `gpt-image-2.5` with `cliproxyapi`.

## Entry Points

The model-facing `imagegen` tool, `/img` commands and lifecycle registrations live in [index.ts](index.ts). Load locally with `pi -e ./extensions/imagegen/index.ts`.

```text
/img gen --provider cliproxyapi --model gpt-image-2.5 --quality low A blue ceramic mug
/img gen --provider cliproxyapi --model gpt-image-2.5-sunburst A watercolor landscape
/img studio
```

Tool calls use `provider` and `imageModel`:

```json
{
  "provider": "cliproxyapi",
  "imageModel": "gpt-image-2.5-sunburst",
  "prompt": "A watercolor landscape",
  "quality": "low"
}
```

Use `/img help` for command options. Studio provider/model controls also apply to batches and references; reruns retain the source image's selection. `thinking` has no effect on the direct Images API and metadata records it as `off`.

## Tool Availability

The model-facing tool requires an exact supported provider/image-model candidate in the effective `imagegen.generate` fallback chain in `tool_models.json`; [shared configuration loading](../lib/tool-models.ts) defines global/project precedence. Image IDs need not be registered chat models. The first registered model for that provider must appear in Pi's locally authenticated `getAvailable()` inventory; `openai` also requires OAuth and an official model base URL. Session models, fuzzy matches and `openai-codex` do not qualify.

Availability is checked at session start and before each agent start, without credential resolution, refresh or network requests. Losing eligibility withdraws the tool from both model declarations and callable/codemode access. Restoring configuration or login requires `/reload` or restart; eligibility never overrides Mode/subagent active-tool policy. Manual `/img` generation, history and studio remain available while the tool is hidden. This local eligibility check does not establish upstream image entitlement or alter generation defaults, routing or retries.

## Providers and Authorization

Configure `cliproxyapi` in Pi's `models.json`; at least one registered model supplies the provider's credential/base-URL configuration. Image model IDs are selected separately and need not appear in Pi's chat picker. Generation uses Pi's request-time resolved key, headers and base URL. A configured `/backend-api/codex` suffix maps to `/v1` on the same proxy; a `/v1` API base is used directly. The extension neither reads proxy-owned upstream credentials nor requires a Codex login in Pi.

For `provider: "openai"`, use `/login openai` and select ChatGPT sign-in. This route requires OAuth credentials and the official `https://api.openai.com/v1` endpoint; it rejects billing-key/header overrides. A valid login does not establish image entitlement: OpenAI's current subscription-sharing service rejects Images requests with “This ChatPass credential is not authorized for the requested operation,” and rejects the Responses `image_generation` tool as an unsupported capability. Those are upstream authorization restrictions, not a missing login. The extension reports the rejection; it does not obtain a different credential or silently switch providers.

Each generation makes one request, without automatic retries, redirects or fallback. PNG, JPEG and WebP responses are validated before saving. Images and history default to Pi's agent directory under `generated-images/`; the tool accepts an explicit output path.

## Studio Access

The studio binds to loopback. HTML (`/`, `/studio`), `/api/*` and `/events` require the studio URL token. Any present Origin must match the request origin exactly, including rejection of `null`; absent Origin is allowed. These checks prevent browser cross-origin access, not access by local same-user processes. The studio is not a sandbox; keep its token-bearing URL private.
