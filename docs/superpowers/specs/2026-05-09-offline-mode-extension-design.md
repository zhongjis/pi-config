# Offline Mode Extension Design

## Goal

Polish `extensions/offline/` so offline mode is a session-scoped guard. A user can enable it for the current Pi session, keep it across reloads of that same session, and avoid any global or project config that silently turns it on in future sessions.

Offline mode must force local model selection, hide cloud models from normal model resolution, block web-dependent tools and agents, and tell both the user and the model that the session is offline.

## Non-goals

- Do not change `extensions/modes/`.
- Do not change `extensions/subagent/` for this feature.
- Do not implement OS-level network blocking.
- Do not block arbitrary shell commands that may access the network.
- Do not disable built-in providers by unregistering or mutating Pi internals beyond the existing `getAvailable()` filter.
- Do not persist activation in `~/.pi/agent/offline.json`, `<cwd>/.pi/offline.json`, environment variables, or settings files.

## User Experience

Users enable offline mode with:

```text
/offline on
```

Users inspect or disable it with:

```text
/offline status
/offline off
```

`/offline on` affects only the current session. If the user reloads the same session, offline mode remains on because the extension records activation in the session log. If the user starts a different session, offline mode starts off.

When offline mode is active, the extension shows one notification per session load:

```text
Offline mode enabled: local models only; web tools and wenchang disabled.
```

The extension also sets a footer/status item, defaulting to:

```text
offline: llama-swap
```

Blocked tools return a clear block reason. The extension does not repeat notifications on every turn.

## Configuration

Activation is not configurable. No file can turn offline mode on.

The extension may still read optional project-local policy from:

```text
<cwd>/.pi/offline.json
```

This file can tune local model policy, but it cannot contain an `enabled` field. The extension must ignore `enabled` if present and should not read `~/.pi/agent/offline.json` at all.

Default policy:

```json
{
  "localProviders": ["llama-swap"],
  "defaultModel": "llama-swap/qwen2.5-coder:14b",
  "blockedAgents": ["wenchang"],
  "blockedTools": ["web_search", "code_search", "fetch_content", "get_search_content"],
  "notifyOnSessionStart": true,
  "statusText": "offline: llama-swap"
}
```

Project policy overrides defaults for these fields only. Invalid JSON ignores the whole project policy and shows one notification. Invalid field types ignore only that field, keep other valid fields, and show one notification per invalid field name.

## Architecture

Keep the extension as a directory extension:

```text
extensions/offline/
├── README.md
├── index.ts
└── offline.test.ts
```

Keep `index.ts` small. It owns policy loading, session state, model filtering, commands, guards, and prompt injection.

### Session Activation State

The extension records activation as session state, not file state.

Use a custom session entry, for example:

```text
panda:offline-mode
```

Entry payload:

```json
{
  "active": true
}
```

On startup, the extension restores activation by scanning `ctx.sessionManager.getEntries()` backward for the latest custom entry with `customType === "panda:offline-mode"`. If that entry has `active: true`, offline mode starts on for that session. If it has `active: false`, offline mode starts off. If no valid entry exists, offline mode starts off. Malformed payloads are ignored.

`/offline on` writes `pi.appendEntry("panda:offline-mode", { active: true })`. `/offline off` writes `pi.appendEntry("panda:offline-mode", { active: false })`. Commands update in-memory state immediately after appending.

Remove activation from:

- global `~/.pi/agent/offline.json`
- project `.pi/offline.json` `enabled`
- `PI_AGENT_OFFLINE_MODE`
- `--offline-mode` flag

Preferred behavior: `/offline on` is the only activation path after startup. If another startup path is needed later, it must append session state and stay off by default for all other sessions.

### Model Guard

When offline mode is active, the extension forces the parent session to a local model. It resolves `defaultModel` through the model registry and calls `pi.setModel()` on `session_start`, `/offline on`, and `before_agent_start` if the current provider is not in `localProviders`.

The extension also wraps `ctx.modelRegistry.getAvailable()` while active so it returns only models whose provider appears in `localProviders`. This makes cloud models invisible to normal model selection and to subagent model fallback resolution.

The wrapper must be defensive:

- Install once per registry.
- Preserve the original `getAvailable()` method.
- Return the unfiltered list only when no offline policy is active for that registry.
- Leave `getAll()` unchanged.

Do not try to disable built-in providers with `pi.unregisterProvider()`. Pi can dynamically register and unregister extension providers, but it has no clean built-in-provider disable API. Filtering `getAvailable()` is the narrowest working hook.

### Subagent Guard

Rely on `extensions/subagent/` frontmatter model fallback chains.

The subagent resolver parses frontmatter like:

```yaml
model: anthropic/claude-opus-4-6:high,llama-swap/gemma4:31b:high
```

It resolves each candidate through `ctx.modelRegistry.getAvailable()`. While offline mode is active, the offline extension filters `getAvailable()` to local providers. Cloud candidates fail, then local candidates win.

Keep enforcement in the offline extension:

1. Block `Agent` calls whose `subagent_type` is in `blockedAgents`.
2. Do not temporarily switch the parent model per agent.
3. Do not maintain an `agentModels` map in offline config.
4. If an agent has no local fallback and no explicit local model, subagent execution may fall back to the already-local parent model.
5. If the user explicitly passes a cloud `model` to `Agent`, the resolver must fail because the cloud model is not available.

This design removes parent-model flicker and uses the fallback chain already owned by the subagent extension.

### Child Agent Sessions

Subagents spawned while the parent session is offline must inherit offline enforcement in memory for that run. They must not append their own `panda:offline-mode` activation entries, read global config, or disable the parent session's active model-registry filter.

This matters because `extensions/subagent/` creates child sessions with their own session managers but reuses the parent model registry. Session-entry scanning alone cannot make child guards active.

The extension therefore needs two activation sources:

1. Session source: the latest valid `panda:offline-mode` entry in the current session manager.
2. Process-local registry source: an offline policy associated with the shared `ctx.modelRegistry`, installed by a parent session when offline mode is active.

Effective active state is true when either source is active. `before_agent_start`, `tool_call`, model forcing, and `getAvailable()` filtering must all use this effective active state. A child extension instance with no session entry must still block configured web tools and blocked agents if its shared registry has an inherited active offline policy.

An instance may clear its own session source with `/offline off`, but it must not remove or bypass a registry-level policy owned by another active parent session. The registry filter returns unfiltered models only when no session source and no inherited registry source is active.

### Tool Guard

On `tool_call`, block any tool name in `blockedTools`.

Initial blocked tools:

- `web_search`
- `code_search`
- `fetch_content`
- `get_search_content`

Do not block shell commands in this iteration. Shell network detection is noisy. Users who need a hard guarantee should rely on actual network absence, OS firewall rules, or container networking.

### System Prompt Injection

On `before_agent_start`, append offline instructions to the system prompt when offline mode is active:

```text
Offline mode is ON.

Constraints:
- Assume no internet access.
- Use only local files, local tools, and local models.
- Do not delegate to wenchang.
- Do not call web, search, or fetch tools.
- Do not suggest online documentation unless the user asks to leave offline mode.
- If external information is missing, state what local evidence is missing and proceed from repo files, local docs, and cached context.
```

This is a behavior nudge, not the enforcement layer. Tool and model guards enforce the important constraints.

### UI

When offline mode becomes active:

- Call `ctx.ui.notify(...)` once per session load if `notifyOnSessionStart` is true.
- Call `ctx.ui.setStatus("offline", config.statusText)`.

When offline mode becomes inactive for the current session:

- Clear the `offline` status for that session.
- Stop blocking tools and agents only if no inherited registry source is active.
- Let `getAvailable()` return all available models only if no other active session owns an offline policy for the shared registry.

## Data Flow

1. Pi loads the extension.
2. Extension registers `/offline` and event handlers.
3. `session_start` loads project policy, restores latest session activation entry, installs the model registry filter, updates status, and forces a local model if effective active state is true.
4. User runs `/offline on`.
5. Extension writes `pi.appendEntry("panda:offline-mode", { active: true })`, updates in-memory state, installs or activates the process-local registry policy, filters model availability, forces a local model, updates status, and notifies the user.
6. User prompt triggers `before_agent_start`.
7. Extension rechecks policy and effective active state, keeps the parent model local, and injects offline instructions.
8. If the model calls tools, `tool_call` blocks web tools and `wenchang` while effective active state is true.
9. If the model calls allowed subagents, the child session inherits effective active state from the shared filtered model registry.
10. Subagent fallback sees only local available models and selects the first local candidate.
11. `/offline off` writes `pi.appendEntry("panda:offline-mode", { active: false })`, clears current-session UI status, and lets `getAvailable()` return all available models only if no inherited registry source remains active.

## Error Handling

- Invalid project policy JSON: show one error notification and ignore the whole project policy.
- Invalid project policy field type: show one error notification for that field and keep the default for that field.
- Unsupported policy fields: ignore them.
- `enabled` in project policy: ignore it and optionally warn once that activation is session-scoped.
- Missing configured default model: choose the first available local model.
- No local model available: show one error notification and keep the current model.
- `pi.setModel()` returns false: show one error notification explaining that the local model is unavailable.
- Disabled offline mode: all guards no-op.

## Testing

Unit tests must cover:

- No global config read from `~/.pi/agent/offline.json`.
- Project policy merge excludes activation and ignores `enabled`.
- `/offline on` appends active session state.
- `/offline off` appends inactive session state.
- Session start restores latest session state entry.
- New session with no session entry starts offline mode off.
- `getAvailable()` filtering keeps only local providers while active.
- Disabling offline mode makes `getAvailable()` return the original available list.
- Parent model is forced when current model is cloud.
- `before_agent_start` injects offline instructions only when active.
- Web tools are blocked only when active.
- `Agent` with `wenchang` is blocked only when active.
- Allowed `Agent` calls do not temporarily switch the parent model.
- Subagent fallback can resolve local candidates through filtered `getAvailable()`.
- Child subagents spawned from an offline parent inherit offline enforcement in memory.
- Child subagent extension instances do not append activation entries just because the parent is offline.
- An inactive child extension instance does not disable an active shared registry filter installed by the parent.
- Notification fires once per session load, not every turn.

Smoke coverage must ensure `extensions/offline/index.ts` loads with the root extension smoke harness.

## Open Questions

None.
