# clauderock

Anthropic-to-AWS-Bedrock failover provider. Automatically routes Claude API requests through Bedrock when the Anthropic API is rate-limited or quota-exhausted.

## What It Does

- Registers as a custom `anthropic` provider, intercepting all Anthropic streaming requests
- On quota (402) or rate-limit (429) errors, transparently falls back to AWS Bedrock using the equivalent model
- Maps Anthropic model IDs (e.g., `claude-sonnet-4-6`) to Bedrock model IDs (e.g., `us.anthropic.claude-sonnet-4-6`)
- Patches Bedrock model IDs back to Anthropic IDs in all responses so pi state stays clean
- Caches fallback state to `~/.pi/agent/clauderock-state.json` across sessions
- Shows `● Clauderock` status bar indicator when fallback is active
- Resolves AWS credentials from profile files, env vars, or SDK chain (handles dual-source conflicts)

## Commands

- `/clauderock` or `/clauderock status` — Show current routing state
- `/clauderock on` — Force all requests through Bedrock
- `/clauderock off` — Switch back to Claude direct API, clear cache
- `/clauderock health` — Check Claude API quota and AWS credential validity
- `/clauderock test` — Run raw Bedrock SDK + pi-ai pipeline diagnostic

## Hooks

- `session_start` — Reset notification flags, detect provider
- `model_select` — Track whether current model is Anthropic
- `message_start` — Notify user of active fallback on first message
- `turn_end` — Deliver deferred quota-exhausted notifications

## Configuration

### Cache file

`~/.pi/agent/clauderock-state.json`:

| Key | Type | Description |
|-----|------|-------------|
| `exhausted` | `boolean` | Whether fallback is active |
| `since` | `string` | ISO timestamp of activation |
| `reason` | `string` | Error message that triggered fallback |

### Environment variables

- `AWS_PROFILE` — AWS profile for Bedrock authentication
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — Static AWS credentials
- `AWS_REGION` / `AWS_DEFAULT_REGION` — AWS region (defaults to `us-east-1`)
