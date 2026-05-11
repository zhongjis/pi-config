# `## Local Tweaks` Manifest Format

The `## Local Tweaks` section in `extensions/<name>/AGENTS.md` is the **authoritative current-state snapshot** of local divergences from upstream. This file is the format spec.

## Purpose

One question, answered in one place: **what diverges from upstream right now, and why?**

The manifest exists so that the `pi-vendored-extension-sync` skill can preserve local adaptations without scraping git history, reading every file diff, or asking the user which changes were intentional. It is read *first* on every sync.

## Scope — what goes in, what stays out

| In | Out |
|----|-----|
| Intentional local divergences from upstream still present | Chronological change history (that is `git log`'s job) |
| Added files not in upstream | Upstream version/commit/SHA (that is `README.md` `## Upstream`) |
| Deleted upstream files | Upstream release notes (that is upstream's changelog) |
| Modified lines in shared files | Design rationale for the feature overall (that is `AGENTS.md` prose) |
| Kept-but-divergent behavior when upstream changed the same file | Divergences already absorbed upstream or already reverted |

Resolved divergences leave the manifest. It is a snapshot, not a log.

## Required shape

```markdown
## Local Tweaks

Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `<path>` | <one-line change description> | <one-line reason> |
```

Required columns, in order: `File`, `What`, `Why`. Column order is fixed so diff tools and sync scripts can pattern-match.

## Optional columns

Append to the right of `Why`, never between required columns:

| Column | Use when |
|--------|----------|
| `Commit` | The divergence traces to one commit you want the sync agent to find quickly. Use the short SHA. |
| `Owner` | The tweak has a named maintainer or depends on an outside-the-repo fact (e.g., an Adobe-internal endpoint). |

Do not add more columns without updating this spec.

## Writing good entries

### File column

- Use the path relative to `extensions/<name>/`.
- For a whole-file replacement, point to the single file.
- For a directory wholesale adaptation (rare), point to the directory and say "directory replaced" in `What`.

### What column

Describe the change, not the feature. Good:

- `Added allowNesting field to AgentConfig`
- `Replaced upstream skill loader with Pi-aware discovery`
- `Local-only file (not in upstream)`

Bad:

- `Better nesting support` — what did you *change*?
- `Fixed bug` — which bug, in which code?
- `Various improvements` — unusable by sync agent.

### Why column

State the reason the divergence must survive the next sync. Good:

- `delegation-policy.ts depends on this field`
- `Supports SKILL.md, ancestor dirs, frontmatter names — upstream only handles flat directories`
- `Auto-steer/abort idle background agents; upstream has no supervision layer`

Bad:

- `Needed` — needed for what?
- `Historical` — then drop the entry; if it still matters, explain why.
- `See commit abc123` — the Why column must stand alone. Use the optional `Commit` column for the reference.

## Worked example

```markdown
## Local Tweaks

Intentional divergences from upstream. Current-state snapshot — preserve these on sync.

| File | What | Why |
|------|------|-----|
| `src/types.ts` | Added `allowNesting` field to `AgentConfig` | `delegation-policy.ts` depends on it |
| `src/agent-runner.ts` | `allowNesting` gate on `EXCLUDED_TOOL_NAMES` filter | Allows nested `Agent` tool when frontmatter opts in |
| `src/skill-loader.ts` | Entire file replaced with Pi-aware discovery | Supports `SKILL.md`, ancestor dirs, frontmatter names |
| `src/background-supervision.ts` | Local-only file (not in upstream) | Auto-steer/abort idle background agents |
| `src/delegation-policy.ts` | Local-only file (not in upstream) | Allow/deny rules for `Agent` tool delegation |
```

## Placement inside `AGENTS.md`

Place `## Local Tweaks` near the end of `AGENTS.md`, after Commands / Where to Look / Always / Ask First / Never / Gotchas. Rationale: day-to-day readers want usage info first; the manifest is primarily for the sync agent.

## Cross-references

- Upstream metadata (source URL, version, commit, license): `extensions/<name>/README.md` `## Upstream` — see `.agents/skills/pi-extension-vendoring/SKILL.md` § README requirements.
- First-time vendoring: `.agents/skills/pi-extension-vendoring/SKILL.md`.
- Sync workflow: `.agents/skills/pi-vendored-extension-sync/SKILL.md`.
- Local adaptation patterns: `.agents/skills/pi-extensions/guides/08-vendored-adaptation.md`.
