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

## Entry Points

- `/clauderock` shows routing state; `/clauderock on|off|health|test` force, clear, check, or diagnose Bedrock routing. Commands, the provider, and hooks are registered in [`index.ts`](index.ts).

## Configuration

- Fallback state is cached at `~/.pi/agent/clauderock-state.json`.
- AWS credentials come from `AWS_PROFILE`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, or the SDK chain; region from `AWS_REGION` / `AWS_DEFAULT_REGION`.
- Cache fields and defaults are defined in [`index.ts`](index.ts).
