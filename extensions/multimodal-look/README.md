# multimodal-look

Adds `look_at`, a dedicated multimodal inspection tool. It sends one image plus a focused goal to a profile-aware vision model and returns concise text findings to the main agent.

## Tools

- `look_at` — Inspect a local image or base64 image with a dedicated vision model.

Parameters:

| Key | Type | Description |
|---|---|---|
| `file_path` | `string` | Path under `ctx.cwd` to a PNG/JPEG/WebP/GIF image. Leading `@` is stripped. Mutually exclusive with `image_data`. |
| `image_data` | `string` | Base64 image data or `data:image/...;base64,...` URI. Mutually exclusive with `file_path`. |
| `mime_type` | `string` | MIME type for bare base64 `image_data`. Defaults to `image/png`. |
| `goal` | `string` | Specific visual question or extraction goal. |

## Model routing

`look_at` keeps the main session model unchanged. At call time it resolves the first available model from a vision-focused chain through `ctx.modelRegistry`, so `extensions/profiles` filtering naturally constrains the choice:

- `default` / `opencode` profiles use OmO fallback chain: `gpt-5.5` → `mimo-v2.5` → `glm-4.6v` → `gpt-5-nano`. The first available model matching the active profile wins.
- If no dedicated vision model is available, `look_at` falls back to the **current agent model** when it declares image input support (`model.input` includes `"image"`).
- On first fallback use per session, a UI warning notification is shown (interactive mode only).
- If neither a dedicated vision model nor the current model supports images, the tool throws a clear error naming the current model.
- `local` profile has no OmO analogue, so the tool will fall back to the current model if it supports vision, or fail clearly otherwise.

## Hooks

None.

## Settings

None. The model chain is hardcoded in `index.ts` to match the repository profile policy.

## Safety

- Maximum input image size: 20 MiB.
- Supported MIME types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`.
- `file_path` must resolve under the current working directory.
- The child vision session runs with no tools, no extensions, no skills, no prompt templates, and no context files.
