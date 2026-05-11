# opencode-zenfall

OpenCode Go → Zen failover. When `opencode-go/<model>` hits 429/402, transparently retries the same request through `opencode/<model>` (Zen tier, same `OPENCODE_API_KEY`, pay-as-you-go).

## What it does

- Wraps the built-in `opencode-go` provider with per-model failover logic
- On quota (402) or rate-limit (429) errors, retries once via `opencode` (Zen) using the same model id
- Caches fallback state per-model in `~/.pi/agent/opencode-zenfall-state.json` with 6h TTL
- Shows `● OpenCode-Zen` status bar when active for the current model
- Patches event model IDs back to `opencode-go/*` so pi state stays clean
- Notifies user on first fallback activation and on session-restore with cached state

## Mapped models

Only 8 of 12 Go models have a Zen equivalent. The other 4 forward quota errors directly — no silent failure, no rotation attempt:

| Mapped (Go → Zen) | No Zen equivalent |
|---|---|
| `glm-5`, `glm-5.1` | `deepseek-v4-flash`, `deepseek-v4-pro` |
| `kimi-k2.5`, `kimi-k2.6` | `mimo-v2.5`, `mimo-v2.5-pro` |
| `minimax-m2.5`, `minimax-m2.7` | |
| `qwen3.5-plus`, `qwen3.6-plus` | |

When you `/model` switch to an unmapped model, a one-shot session notification warns you.

## Commands

- `/opencode-zenfall` or `/opencode-zenfall status` — show active fallback entries
- `/opencode-zenfall on <model-id>` — force Zen for a specific model (must have Zen equivalent)
- `/opencode-zenfall off [<model-id>]` — clear one entry, or all if omitted; Go is retried next call
- `/opencode-zenfall health` — list all Go models with/without Zen equivalents and their cache state

## Configuration

### Cache file

`~/.pi/agent/opencode-zenfall-state.json`:

```json
{
  "kimi-k2.6": {
    "since": "2026-05-11T16:28:36.123Z",
    "reason": "Rate limit exceeded"
  }
}
```

Entries auto-expire after 6 hours so Go is retried once daily reset windows pass.

### Environment variables

- `OPENCODE_API_KEY` — shared between Go and Zen (built-in pi-ai mapping)

## Design notes

- **Per-model cache.** Go quotas are per-model-per-month. A global flag would route `kimi-k2.6` traffic to Zen after `glm-5.1` exhausts — wasteful and costs real money on Zen.
- **6-hour TTL.** Go resets at varying cadences (5h rolling, weekly, monthly). 6h auto-retry bounds the worst case without hammering a known-exhausted endpoint.
- **No chain beyond Zen.** If Zen also fails (balance exhausted), the error forwards to the user cleanly. No third tier.
- **Zen costs real money.** Unlike Bedrock (flat AWS cost), Zen is pay-per-token. Fallback is not free.

## Related

- [`extensions/clauderock/`](../clauderock/) — analogous anthropic → bedrock failover
- [`extensions/lib/stream-fallback.ts`](../lib/stream-fallback.ts) — shared failover primitive
- [`docs/opencode-agent-models.md`](../../docs/opencode-agent-models.md) — per-agent model assignments under the opencode profile
