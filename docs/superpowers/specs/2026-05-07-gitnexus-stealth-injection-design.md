# GitNexus Stealth Injection — Design

**Date:** 2026-05-07
**Status:** Draft, pending user review
**Scope:** `extensions/gitnexus/`, root `.gitignore`, root `AGENTS.md`, new `scripts/sync-gitnexus-resources.sh`

## Problem

`/gitnexus analyze` mutates the repo working tree on every run:

1. Rewrites `<!-- gitnexus:start --><!-- gitnexus:end -->` block in `AGENTS.md`. Symbol/relationship counts change each run → `AGENTS.md` is perpetually dirty in `git status`.
2. Writes `.claude/skills/gitnexus/<6 dirs>/SKILL.md` as untracked files.
3. Creates root `CLAUDE.md` as an untracked file.

Net effect: every refresh of the knowledge graph index leaves repo-affecting artifacts. The user wants zero working-tree impact from `analyze`, while preserving the agent's access to the GitNexus contract and skills.

## Goal

After `/gitnexus analyze` runs, `git status` is clean. Skills and the GitNexus instruction contract still reach the agent, via pi-native runtime injection instead of committed/untracked files. Upstream skill template updates remain syncable, but only by explicit human action.

## Non-goals

- Modifying the `gitnexus` binary (upstream `abhigyanpatwari/GitNexus`).
- Modifying the `tintinweb/pi-gitnexus` adapter upstream.
- Changing tool schemas, MCP client, or augmentation hook behavior.
- Making the GitNexus block visible to other harnesses (e.g., Codex CLI reading AGENTS.md statically) — stealth in pi is the only target.

## Verified pi-native primitives

All mechanisms below are confirmed against pi 0.73.0 docs and type declarations:

| Primitive | Verified source |
|---|---|
| `before_agent_start` hook returning `{systemPrompt}` mutates per-turn system prompt | `docs/extensions.md:471-496` |
| Runtime skill path injection via `resources_discover` event | `docs/extensions.md:337-354`, `examples/extensions/dynamic-resources/index.ts` |
| `resources_discover` accepts file or directory paths under `skillPaths` | `examples/extensions/dynamic-resources/index.ts:10` |
| `pi.skills` manifest field loads skills from package directories | `docs/packages.md:119-126`, `docs/skills.md:32` |
| `before_agent_start` fires per user prompt (not per session) — safe for repeated injection | `docs/extensions.md:282` |

Existing extension code already uses `before_agent_start` for a one-liner hint (`src/index.ts:77-88`) and `pi.skills: ["./skills"]` for the vendored skill directory (`package.json:45-47`). This spec extends those patterns; it does not introduce a new pattern.

## Design

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ /gitnexus analyze (slash command)                           │
│   ├─ spawns: gitnexus analyze --skip-agents-md --no-stats   │
│   │          (never --skills)                               │
│   └─ writes only: .gitnexus/ (already in .gitignore)        │
│                                                              │
│ Extension lifecycle (per session):                          │
│   session_start                                             │
│     ├─ existing: probe binary, clear caches                 │
│     └─ new: compare binary version vs                       │
│        VENDORED_TEMPLATE_VERSION, notify on drift           │
│   before_agent_start (expanded from one-liner)              │
│     └─ returns {systemPrompt: base + GitNexus contract}     │
│                                                              │
│ Skill loading (static, package-manifest):                   │
│   pi reads package.json pi.skills → loads                   │
│   extensions/gitnexus/skills/* at startup. No runtime       │
│   event needed; existing path.                              │
│                                                              │
│ Upstream sync (human-initiated):                            │
│   scripts/sync-gitnexus-resources.sh                        │
│     ├─ runs `gitnexus analyze --force --skills` in temp dir │
│     ├─ diffs against vendored copy                          │
│     ├─ rsync approved changes into                          │
│     │  extensions/gitnexus/skills/                          │
│     └─ bumps extensions/gitnexus/skills/VERSION             │
└─────────────────────────────────────────────────────────────┘
```

### Component 1 — Remove AGENTS.md block

One-time commit:
- Delete lines from `<!-- gitnexus:start -->` through `<!-- gitnexus:end -->` in `AGENTS.md`.
- Delete the blank line separator above the block if present.

No sentinel, no pointer comment. Stealth means stealth.

### Component 2 — Expand `before_agent_start` injection

Current (`src/index.ts:77-88`): ~4 lines of text appended to `systemPrompt` when a `.gitnexus/` index is present.

Replacement: expanded GitNexus contract built at hook-time, not a verbatim lift of the current `<!-- gitnexus:start/end -->` block. Two parts:

**Part A — Static prose** (module-level `GITNEXUS_CONTRACT_PROSE` constant): the "Always Do", "Never Do", "Resources" sections from the current block. Numbers (symbols, relationships, flows) dropped — they affect no agent decision. Freshness reminder ("if stale, run /gitnexus analyze") kept. **No `.claude/skills/...` paths appear anywhere in this constant.**

**Part B — Runtime-derived skill list**: inside the hook, filter `event.systemPromptOptions.skills` for names starting with `gitnexus-`. Format as a short reference list (names only, no filesystem paths — pi's skill registry already makes skills loadable by name). If zero gitnexus skills loaded, emit a single line stating this with a pointer to the sync script; no list. This makes the contract self-healing across skill add/rename/remove and removes a drift failure class.

Final injected text = `base systemPrompt + "\n\n" + GITNEXUS_CONTRACT_PROSE + derivedSkillList`.

Gate remains: only inject when `findGitNexusIndex(ctx.cwd)` returns a path. No index → no injection, no wasted context.

Rationale for runtime derivation (Part B): the current committed block references 6 skills by filesystem path; the vendored tree has 5 skills with one name mismatch (`pr-review` vendored; `guide` / `cli` not). Verbatim lift would inject dead paths and reference skills pi never loaded. Deriving from `systemPromptOptions.skills` removes the coupling to any static name list and makes the first-run state correct regardless of future sync outcomes.

### Component 3 — CLI flag composition

In `src/index.ts`, the `/gitnexus analyze` subcommand handler builds `spawn(bin, [...baseArgs, 'analyze', ...userArgs])` (current shape to be verified by implementer). Change: prepend `--skip-agents-md` and `--no-stats` to the args, before any user-provided args. Never pass `--skills`.

Rationale: `--skip-agents-md` stops the AGENTS.md/CLAUDE.md block rewrite. `--no-stats` is defense in depth — if a future upstream change reintroduces the block, stats won't churn. `--skills` is opt-in upstream; omitting it keeps skill file generation suppressed.

Users invoking raw `gitnexus analyze` outside pi still get files written. That's out of scope for stealth inside pi; belt-and-suspenders via `.gitignore` covers it.

### Component 4 — `.gitignore` entries

Append to root `.gitignore`:

```
.claude/
CLAUDE.md
```

Purpose: if any invocation path (direct CLI run, forgotten flag, upstream regression) writes these files, they never reach version control.

### Component 5 — Sync script

New file: `scripts/sync-gitnexus-resources.sh`. Bash. Manual invocation only. Never auto-runs, never called by extension.

Behavior:

1. Create scratch dir under `$(mktemp -d)/gitnexus-sync`.
2. `git init` the scratch dir, `touch package.json` so gitnexus treats it as a valid target.
3. Run `gitnexus analyze --force --skills` inside scratch dir. Capture exit code; abort on non-zero.
4. Diff each scratch `SKILL.md` against the corresponding file under `extensions/gitnexus/skills/`.
5. Print a summary: skill file count added/modified/removed, contract-block diff lines.
6. If `--dry-run`, exit here.
7. Otherwise, prompt `Apply changes? [y/N]` and on `y`, rsync `SKILL.md` files into the vendored tree.
8. Print: the binary version (from `gitnexus --version`), the current `extensions/gitnexus/skills/VERSION`, and a suggested commit message.
9. **Do not auto-edit `src/index.ts`.** If the upstream contract block diverges, print the diff and path; human patches the `GITNEXUS_CONTRACT_PROSE` constant.

Exit codes: 0 success or no-op, 1 upstream run failed, 2 user declined apply, 3 other error.

### Component 6 — Drift detection

New file: `extensions/gitnexus/skills/VERSION` — single line, binary version string that the vendored skills match (e.g., `1.6.3`). Updated by the sync script; committed.

In `src/index.ts`, existing `session_start` handler gains:
- Read `VERSION` file (relative to extension module dir).
- Parse `gitnexus --version` output captured during existing binary probe.
- If mismatch, one-shot `ctx.ui.notify(message, "warning")`. Message names both versions and points to the sync script. (Note: existing code in `src/index.ts` uses `"warning"`, not `"warn"` — match that.)

Non-blocking. Never fails session start. If `VERSION` file is missing or unreadable, skip the check silently.

## Data flow after change

```
user runs `/gitnexus analyze`
  → extension spawns gitnexus analyze --skip-agents-md --no-stats
    → binary writes .gitnexus/ only
      → git status: clean ✓

pi startup (before any session)
  → package manifest scan → pi.skills entry resolves to
     extensions/gitnexus/skills/* → skills loaded into registry

user starts new pi session
  → session_start handler runs
    → probes binary, reads VERSION file
    → if drift: notify, continue
  → user submits prompt
    → before_agent_start fires
      → if .gitnexus/ index present, append prose + runtime-derived skill list to systemPrompt
    → agent runs with contract in context ✓
```

## Error handling

- **`.gitnexus/` absent** → `before_agent_start` returns nothing; no contract injected. Existing behavior, preserved.
- **`VERSION` file missing** → drift check skipped silently. First sync-script run creates it.
- **Binary not on PATH** → existing probe in `session_start` already handles this; drift check inherits the skip.
- **Sync script: scratch analyze fails** → exit 1, leave repo untouched.
- **Sync script: user declines apply** → exit 2, leave repo untouched.
- **`--skip-agents-md` or `--no-stats` unknown to binary** (old version) → `gitnexus` will fail fast; extension slash command surfaces the error as it does today.

## Testing

**Harness context:** `extensions/gitnexus/` currently has **zero** test files. This spec introduces the first. Root `vitest.config.ts` includes `extensions/**/*.test.ts`, so any file placed under `extensions/gitnexus/test/` is auto-discovered — no config edit required. New test file path: `extensions/gitnexus/test/stealth-injection.test.ts`. Implementer needs to add lightweight test setup (mocks for `fs.existsSync`, `findGitNexusIndex`, and `ctx.ui.notify`) since no fixtures exist in this package.

Unit-level assertions:

1. `before_agent_start` with `.gitnexus/` present → returned `systemPrompt` contains the word `gitnexus_query` (signature token from contract prose).
2. `before_agent_start` with no `.gitnexus/` → returned object does not set `systemPrompt`.
3. `before_agent_start` derives skill list from `event.systemPromptOptions.skills` filtered by `gitnexus-` prefix — injected text contains each loaded skill name, and **no `.claude/skills/` string** appears anywhere in the output.
4. `before_agent_start` with zero `gitnexus-*` skills loaded → injected text still has prose but a single-line fallback pointing at the sync script (no empty list).
5. Slash command for `/gitnexus analyze` composes args with `--skip-agents-md` and `--no-stats` as a prefix. Never includes `--skills`.
6. Drift check: when `VERSION` matches probed binary, no notify fires; when they differ, notify is called once with both versions in the message.
7. Drift check: `VERSION` missing → no notify fires, no throw.

Integration-level:

8. **Automated** (promoted from manual): `spawn gitnexus analyze` in a `mktemp` scratch repo with the extension's flag composition, assert `git status --porcelain` is empty afterward. Binary is Nix-pinned in dev shell so this is deterministic. This test most directly validates the spec's top-level goal; worth the cost.
9. Manual: run `scripts/sync-gitnexus-resources.sh --dry-run` against a checkout, verify it reports diffs without modifying tracked files.

## Migration

One-time human steps, in this order:

1. Merge the code changes from this spec.
2. Commit: delete `<!-- gitnexus:start/end -->` block from `AGENTS.md`; add `.claude/`, `CLAUDE.md` to `.gitignore`.
3. If `.claude/` or `CLAUDE.md` currently exist untracked, delete from disk.
4. Run `scripts/sync-gitnexus-resources.sh` once to establish `extensions/gitnexus/skills/VERSION` against the installed binary. Commit the version file (and any skill updates it surfaces).

No schema migration, no data migration.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Upstream `tintinweb/pi-gitnexus` adapter re-vendor overwrites our expanded `before_agent_start`. | Extension is already vendored with `piVendor` metadata and local diffs documented. Add contract changes to the Local Additions section of `extensions/gitnexus/README.md`. |
| Binary introduces a new flag that regenerates repo files despite our flags. | Defense in depth: `.claude/`, `CLAUDE.md` gitignored; `AGENTS.md` has no marker block for regenerator to target. |
| Vendored skills drift far from binary templates between syncs. | `session_start` drift notify tells the human; sync script is one command away. |
| Sync script mistakes a local edit for a stale file and overwrites it. | Prompt before apply; dry-run flag; user reviews the printed diff. No force-overwrite mode. |
| `.gitignore` additions break developer workflows that rely on `.claude/` (e.g., Claude Code side). | `.claude/` is Claude-Code-specific; this repo is pi-centric per root `AGENTS.md`. Root file already says edits to repo skills don't propagate to live setup (Home Manager managed). Low risk. |
| Expanded contract increases systemPrompt size in every pi session, including short-lived subagent sessions launched by `extensions/subagent`. | Existing one-liner already ships into subagents, so new cost is incremental, not categorical. Gate remains on `findGitNexusIndex`. If measured cost becomes material, follow-up: gate on a subagent-detection signal (e.g., checking `ctx.sessionManager` type or a flag passed by the subagent extension). Not blocking for this spec. |

## What this spec does not decide

- Whether to also expose the contract content via a `/gitnexus contract` slash command for on-demand display. Out of scope; not requested.
- Whether to vendor `gitnexus-guide` and `gitnexus-cli` skills (present in binary templates, absent from current `extensions/gitnexus/skills/`). Deferred to the first sync-script run — if the script surfaces them, human decides then. The runtime-derived skill list in Component 2 means the contract stays correct either way: if vendored, they appear in the list; if not, they don't.
- CI enforcement of `git status` clean after `analyze`. Out of scope; trust and tooling, not CI gate.

## Implementation sequence (informs the plan)

Implementers work in this order to keep each change reviewable:

**Atomic group (one commit or strictly sequenced PR) — steps 1–3 must land together.** If step 3 lands without steps 1–2, the next `/gitnexus analyze` will re-write the AGENTS.md block that step 3 deleted and dirty the tree. These three steps are the minimum stealth set.

1. Extract `GITNEXUS_CONTRACT_PROSE` constant and runtime skill-list derivation; expand `before_agent_start`. Add unit tests (#1–#4 from Testing).
2. Add `--skip-agents-md --no-stats` to `/gitnexus analyze` arg composition. Add unit test #5.
3. Add `.gitignore` entries. One-time repo cleanup commit for `AGENTS.md` block.

**Follow-up (separate commits):**

4. Add `VERSION` file + drift check in `session_start`. Add unit tests #6–#7.
5. Write `scripts/sync-gitnexus-resources.sh`. Manual verification (no unit test — it's a bash script that spawns real binary).
6. Add automated integration test #8 (spawn-analyze-in-scratch, assert clean `git status`).
7. Run sync script once, commit resulting `VERSION` and any skill updates.
8. Update `extensions/gitnexus/README.md` Local Additions section.
