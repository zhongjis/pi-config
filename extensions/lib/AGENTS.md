## Purpose

Provide shared extension utilities and integration primitives.

## Ownership

- Owns the flat utility modules, barrel exports, and local tests.
- Callers retain extension-specific lifecycle and state ownership.

## Local Contracts

- `initLib(pi)` wires debug support idempotently across callers.
- The default discovery entrypoint MUST remain a no-op; consumers initialize explicitly.
- Utilities include clipboard I/O and logging; not all helpers are pure.
- RPC requests MUST carry `requestId`; replies use `{ success: true, data? }` or `{ success: false, error: string }`.
- Temporary RPC reply listeners MUST unsubscribe on settlement or timeout.
- [Runtime model fallback](runtime-model-fallback.ts) coordinates transient/quota/rate-limit/access-denied recovery after native retries; callers own chain and thinking/Fast policy. Transient failures and CLIProxyAPI quota failures use the shared backoff schedule before chain advancement, including the last or only candidate. The schedule permits four total attempts per model (initial plus three retries), counting native failures without extending an exhausted budget; native `retry.maxRetries` instead counts additional retries and its policy stays unchanged. Same-model continuation omits failed assistant/tool pairs from model context while preserving transcript and completed tools; chain advancement uses hidden continuation without cycling authenticated identities. Stop on abort, overflow, other errors, absent/unavailable chains, or exhaustion of both budgets. An abort during backoff suppresses continuation after the current wait finishes, not immediately (at most the longest backoff slot). Manual model selection/new input invalidates a pending wait. [Provider error classification](provider-errors.ts) owns transient signatures and prefers recognized terminal provider codes, then HTTP status, with wording as fallback for quota/rate/access metadata.
- Model chains parse terminal `:fast` after an optional thinking suffix; absent fast metadata retains the legacy object shape and means off to consumers.
- `fast.ts` owns stateless eligibility, transforms, and policy resolution: latest user preference from full session entries, otherwise current-branch mode defaults. Preserve [helper contracts](README.md#fast-request-helpers). Callers MUST validate explicit on before strict application; NEVER mutate shared models.
- Fast allowlist changes require official provider evidence for exact public model IDs, matching regression tests, and updated [support documentation and sources](README.md#fast-request-helpers); no inferred aliases, wildcards, or internal models.
- CLIProxyAPI Fast profiles support only `cliproxyapi` / `openai-responses` or `openai-codex-responses` and accept Pi local API-key auth; preserve the separate OpenAI Codex OAuth requirement.
- `tool-output.ts` owns shared passive TUI helpers, including custom-message Box shells; callers retain content construction and delivery. Its width-safe components MUST NOT emit full SGR resets, so Pi's tool-row background survives.
- `active-tools.ts` owns the shared `extensions:`/`tools:`/`delegation:` access policy: rule parsing (`delegation:` parsing only, accepting `@all` or exact agent names), last-match-wins evaluation, groups, extension identity, and the ceiling tool. Mode and subagent loadout, blocking, nested guards, roster, and menu MUST use it.
- Hard gates MUST apply after rules: trusted `<inline:…>`/`<sdk:…>` sources always allowed; nested controls (including `agent_graph`, result retrieval, and graph-gate resolution) require the caller-computed `allowNesting` gate (true only when `delegation` rules resolve to a valid target), and `tools` rules NEVER override `allowNesting: false`; goal tools require Goal access; plan tools only where the plan gate grants them.
- `BUILTIN_TOOL_NAMES` is a copy of Pi's built-in tool list; update it when Pi adds a built-in tool.
- [pane-host.ts](pane-host.ts) owns host selection: herdr-app takes precedence over Orca. [herdr-app.mjs](herdr-app.mjs) resolves exact live terminal/pane associations for extensions and the plain-Node viewer. An unmatched HC terminal MUST NOT fall back to inherited host variables or focused context; callers retain lifecycle ownership.
- [Prompt variants](prompt-variants.ts) owns shared directory reading and body selection; callers parse default-file frontmatter and retain lifecycle/state ownership. Only missing prompt files are optional; other read failures propagate to callers.
- [mode.ts](mode.ts) owns the run-mode predicate `isTui` and `registerTuiCommand`/`registerTuiShortcut`, which register from a `tui` `session_start` and keep no module-level state. New terminal-only commands MUST use `registerTuiCommand` so RPC `get_commands` never lists them; new terminal-only shortcuts MUST use `registerTuiShortcut` so headless runs never register them. The helpers rely on Pi awaiting `session_start` before building slash autocomplete and binding shortcuts; on each Pi bump, re-run interactive QA (autocomplete, shortcut, `/reload`, `/new`).
- RPC-mode contract (for example T3 Code): every command `get_commands` lists and every tool MUST work through RPC-visible surfaces (tool results, blocking `select`/`confirm`/`input`/`editor` dialogs, in-turn `notify`) or be terminal-only. Outside `isTui`, extensions MUST NOT call `ui.custom()` or component factories, spend model calls on output only the terminal shows (widgets, status, footer, header, custom messages), or replace the session (`newSession`, `switchSession`, `fork`), which RPC clients cannot follow. Terminal decoration MAY no-op silently. Gate on run mode only; do not detect specific clients.

## Work Guidance

- You SHOULD reuse [existing modules](README.md#modules) before adding utilities.
- Shared public utilities MUST be re-exported through [index.ts](index.ts).
- You MUST keep extension-specific state outside this shared library.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/lib/test`.
- [RPC tests](test/rpc.test.ts) cover envelopes and listener lifecycle.

## Child DOX Index

- None; this document owns the entire subtree.
