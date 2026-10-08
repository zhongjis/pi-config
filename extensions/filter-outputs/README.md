# filter-outputs

Redacts sensitive data from tool outputs before the LLM sees them.

## What It Does

Hooks into `tool_result` events, including error results and nested calls from codemode scripts, and applies regex-based redaction for:

- **API keys/tokens:** OpenAI (`sk-`), GitHub (`ghp_`, `gho_`), Slack (`xox*`), AWS (`AKIA`)
- **Generic secrets:** `api_key=`, `secret=`, `token=`, `password=` patterns
- **Auth headers:** Bearer tokens
- **Database URLs:** MongoDB, PostgreSQL, MySQL, Redis connection strings with passwords
- **Private keys:** RSA, EC, OpenSSH private key blocks

Every text block of a result is redacted; images and other blocks keep their position. `structuredContent`, the machine-readable result that codemode scripts and JSON/RPC clients receive, is redacted string by string, so its shape stays intact.

Additionally redacts entire file contents when a successful `read` accesses sensitive files:
- `.env` (but not `.env.example`), `.dev.vars`, `secrets.json`, `secret.yaml`, `credentials`

Shows one notification per redacted top-level result. Nested calls are redacted without a notification.

The `tool_result` hook, redaction patterns, and scan bounds are defined in [`index.ts`](index.ts).

## Limits

- Temp files that tools write with full output (`pi-bash-*.log`, `pi-mcp-*.txt`, `pi-codemode-*.txt`) keep the raw text.
- Streaming `tool_execution_update` output is not redacted.
- Tools that truncate output before this hook runs can split a secret so that no pattern matches it.
- Scans are bounded: database URL user and password parts match up to 256 characters each, and private-key bodies up to 16384 characters. Longer values are not redacted.
- `structuredContent` that is not plain JSON, is nested deeper than 64 levels, or holds more than 2 MiB (2,097,152 characters) of string values is dropped, so scripts receive only the redacted text. Object keys are not scanned.
- Output of user `!` bash commands is not redacted.
