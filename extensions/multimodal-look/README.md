# multimodal-look

Adds `look_at`, a dedicated multimodal inspection tool. It sends one image plus a focused goal to a profile-aware vision model, then returns concise text findings plus the original image as a tool-result image block.

## Entry Points

- `look_at` — inspect one local image (`file_path`) or base64 image (`image_data`) against a `goal`. [index.ts](index.ts) registers the tool and its parameters.

## Model routing

`look_at` keeps the main session model unchanged. It resolves shared key `multimodal-look.inspect` through role `vision.inspect` in `tool_models.json`. Built-in, global `~/.pi/agent/tool_models.json`, then project `.pi/tool_models.json` load in precedence order; a direct tool chain wins over its role.

[../lib/tool-model-defaults.ts](../lib/tool-model-defaults.ts) defines the built-in chain. The first candidate available through `ctx.modelRegistry` wins, preserving its configured thinking level and active profile filtering.

If no configured candidate resolves, `look_at` falls back only when the current model declares image input support (`model.input` includes `"image"`). The first fallback per session emits the existing interactive warning. Otherwise it throws the existing explicit error.

## Settings

Configure role `vision.inspect` or tool key `multimodal-look.inspect` through shared `tool_models.json`.

## Safety

- Input size and MIME type are limited; [index.ts](index.ts) defines the limits.
- `file_path` accepts absolute paths or paths relative to the current working directory; a leading `@` is stripped.
- The child vision session runs with no tools, no extensions, no skills, no prompt templates, and no context files.
