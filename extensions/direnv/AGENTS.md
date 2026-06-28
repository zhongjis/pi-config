# direnv extension

Vendored from `https://github.com/rytswd/pi-agent-extensions/tree/main/direnv`.

## Local Tweaks

Intentional divergences from upstream. Preserve these on sync.

| File | What | Why |
|------|------|-----|
| `index.ts` | Added session-version and stale-context guards around UI/status updates | Prevents crashes when Pi invalidates old extension contexts |
| `index.ts` | Handles `session_switch` and `session_tree` in addition to upstream `session_start` / `session_shutdown` | Keeps env loaded after active session changes |
| `index.ts` | Uses shared `../lib/utils.js` `debounce` helper instead of upstream inline timer | Matches repo utility pattern and exposes `cancel()` cleanup |
| `index.ts` | Uses theme color token `error` for `direnv:error` instead of upstream `danger` | Matches current local Pi theme tokens |
| `README.md` | Local concise README with provenance and local additions | Repo docs omit upstream install/marketing content |
| `AGENTS.md` | Local-only sync manifest | Protects intentional divergences during future upstream syncs |

## Upstream Notes

- Last checked upstream commit: `9df8ca72acda83b4249f50c4b0211ac217d94624`.
- Upstream has no releases, tags, or direnv-specific changelog.
- Upstream README still describes the older per-bash-hook behavior, while upstream code now uses `direnv export json` plus file watchers.

## Child DOX Index

No child `AGENTS.md` files. This file owns all files under `extensions/direnv/`.
