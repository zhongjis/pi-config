# Recap

Vendored from [L2ncE/pi-recap](https://github.com/L2ncE/pi-recap) at commit `02057d07ab2ec2dd96d3fab50112d1112ad9e614`.

Copyright 2026 L2ncE. Licensed under Apache-2.0; see [LICENSE](LICENSE).

## Local changes

- Content, settings, model selection, and lifecycle live in separate modules.
- Model selection uses the `tool_models.json` key `recap.generate`, mapped to `summary.session`; `recap.model` is not supported.
- Configured chain candidates are tried in order before an authenticated current-session-model fallback; cancellation stops retries.
