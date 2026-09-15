# multimodal-look

Adds `look_at`, a dedicated multimodal inspection tool. It sends one image plus a focused goal to a profile-aware vision model, then returns concise text findings plus the original image as a tool-result image block.

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

`look_at` keeps the main session model unchanged. It resolves shared key `multimodal-look.inspect` through role `vision.inspect` in `tool_models.json`. Built-in, global `~/.pi/agent/tool_models.json`, then project `.pi/tool_models.json` load in precedence order; a direct tool chain wins over its role.

The default chain is `gpt-5.5:medium,mimo-v2.5,kimi-k2.6,glm-4.6v,gpt-5-nano`. The first candidate available through `ctx.modelRegistry` wins, preserving its configured thinking level and active profile filtering.

If no configured candidate resolves, `look_at` falls back only when the current model declares image input support (`model.input` includes `"image"`). The first fallback per session emits the existing interactive warning. Otherwise it throws the existing explicit error.

## Hooks

None.

## Settings

Configure role `vision.inspect` or tool key `multimodal-look.inspect` through shared `tool_models.json`.

## Safety

- Maximum input image size: 20 MiB.
- Supported MIME types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`.
- `file_path` must resolve under the current working directory.
- The child vision session runs with no tools, no extensions, no skills, no prompt templates, and no context files.
