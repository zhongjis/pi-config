# filter-outputs

Redacts sensitive data from tool outputs before the LLM sees them.

## What It Does

Hooks into `tool_result` events and applies regex-based redaction for:

- **API keys/tokens:** OpenAI (`sk-`), GitHub (`ghp_`, `gho_`), Slack (`xox*`), AWS (`AKIA`)
- **Generic secrets:** `api_key=`, `secret=`, `token=`, `password=` patterns
- **Auth headers:** Bearer tokens
- **Database URLs:** MongoDB, PostgreSQL, MySQL, Redis connection strings with passwords
- **Private keys:** RSA, EC, OpenSSH private key blocks
- **JWT/base64 secrets:** Long base64-like strings in secret contexts

Additionally redacts entire file contents when `read` tool accesses sensitive files:
- `.env` (but not `.env.example`), `.dev.vars`, `secrets.json`, `secret.yaml`, `credentials`

Shows a notification when redaction occurs.

## Hooks

- `tool_result` — Scans and redacts sensitive patterns from tool output text
