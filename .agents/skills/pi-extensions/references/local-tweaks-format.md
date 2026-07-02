# Local Tweaks Manifest Format

Use this reference for vendored Pi extensions that intentionally diverge from upstream.

`extensions/<name>/AGENTS.md` must include `## Local Tweaks` when local changes exist. The section is a current-state snapshot: it explains what differs now and why future syncs must preserve it.

Do not use this section as a changelog. Git history records when changes happened; this manifest records what must be preserved.

## Required shape

```markdown
## Local Tweaks

Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `src/types.ts` | Added `allowNesting` field to `AgentConfig` | delegation-policy.ts needs it |
| `src/background-supervision.ts` | Local-only file (not in upstream) | Auto-steer/abort idle background agents |
```

## Required columns

- `File`: local path relative to the extension root.
- `What`: concise description of the divergence. Name changed symbols, local-only files, deleted upstream files, config-path changes, event changes, package-script changes, or pinned dependency differences.
- `Why`: current reason the divergence still exists.

Optional column:

- `Commit`: introducing commit SHA if useful. Do not rely on it as the only explanation.

## Rules

- One row per intentional divergence.
- If a file is entirely local-only, say `Local-only file` in `What`.
- If only a few lines differ, name the behavior or symbol that differs.
- Drop entries once the divergence is gone because upstream absorbed it or local code reverted it.
- Keep upstream metadata out of this section. Source URL, last synced version/commit, and license belong in `README.md` `## Upstream`.
- Preserve listed divergences during sync unless the user approves removing them.
