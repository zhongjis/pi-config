# Recap

Vendored from [L2ncE/pi-recap](https://github.com/L2ncE/pi-recap) at commit `02057d07ab2ec2dd96d3fab50112d1112ad9e614`.

Copyright 2026 L2ncE. Licensed under Apache-2.0; see [LICENSE](LICENSE).

## Local changes

- Split the extension by content, settings, model selection, and lifecycle responsibilities.
- Replace `recap.model` selection with the repository `tool_models.json` key `recap.generate`, mapped to `summary.session`.
- Retry configured chain candidates before an authenticated current-session-model fallback; cancellation stops retries.
