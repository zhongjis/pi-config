// Provenance: upstream SUL concepts informed this prompt shape; wording here is original, Pi-native, and intentionally not a wholesale copy.
export const INIT_DEEP_TEMPLATE = `# /init-deep

Generate hierarchical AGENTS.md files. Root plus complexity-scored child docs.

## Usage

/init-deep                      # Update mode: modify existing plus create new where warranted
/init-deep --create-new         # Read existing docs, then remove/regenerate AGENTS.md hierarchy
/init-deep --max-depth=N        # Limit child-doc depth. Default: 3

## Command Contract

- Preserve raw invocation semantics: --create-new and --max-depth=N must be honored exactly.
- Always read existing AGENTS.md and CLAUDE.md before writing. With --create-new, harvest context first, then delete/regenerate AGENTS.md files.
- Never require tools absent from active Pi runtime. Prefer first-class discovery tools when available, fallback cleanly.
- Use Pi-native tools/agents: Task (op:create/update/list/get), Agent/chengfeng, Agent/jintong, CodeGraph if available, LSP if available, rg, fd, read, edit, write.

## Workflow

1. Plan tasks — create pi-tasks for discovery, scoring, root generation, child generation, review.
2. Discover concurrently — main session maps repo while background chengfeng agents explore by topic.
3. Score dirs — choose AGENTS.md locations with complexity plus centrality signals.
4. Generate root first — root AGENTS.md owns repo-wide rules and child index.
5. Generate child docs in parallel — one jintong per selected child dir, only local facts.
6. Review hard — dedupe, trim, telegraphic style, validate commands and links.

Task pattern:
  Task({ op: "create", tasks: [
    { subject: "Discovery: map repo + launch chengfeng", description: "init-deep phase 1" },
    { subject: "Scoring: choose AGENTS.md locations", description: "init-deep phase 2" },
    { subject: "Generate root AGENTS.md", description: "init-deep phase 3a" },
    { subject: "Generate child AGENTS.md files", description: "init-deep phase 3b" },
    { subject: "Review: dedupe + trim + validate", description: "init-deep phase 4" },
  ] })
  Task({ op: "update", tasks: [{ taskId: "...", status: "in_progress" }] })
  Task({ op: "update", tasks: [{ taskId: "...", status: "completed" }] })

## Phase 1: Discovery + Analysis

Mark discovery task in_progress.

### Start Background Exploration Immediately

Launch chengfeng agents before deep local reading. Keep prompts narrow. Ask for deviations, not generic ecosystem facts.

Baseline agents:
  Agent(subagent_type="chengfeng", description="Map project structure", run_in_background=true, prompt="Find major directories, entrypoints, generated/runtime dirs, package/workspace boundaries. Report only repo-specific facts.")
  Agent(subagent_type="chengfeng", description="Find commands", run_in_background=true, prompt="Read package/config/build files. Report exact dev/test/lint/typecheck/build commands plus caveats.")
  Agent(subagent_type="chengfeng", description="Find conventions", run_in_background=true, prompt="Find local style rules, naming, layouts, event/API contracts, config-driven constraints. Report concrete examples.")
  Agent(subagent_type="chengfeng", description="Find tests", run_in_background=true, prompt="Map test tiers, stubs, integration requirements, fixtures, slow tests, focused commands.")
  Agent(subagent_type="chengfeng", description="Find hazards", run_in_background=true, prompt="Search for DO NOT, NEVER, ALWAYS, DEPRECATED, TODO, FIXME, migrations, generated/runtime state. Report durable warnings only.")

### Dynamic Background Exploration by Project Scale

Measure scale first with fd/rg and CodeGraph when available. Spawn more chengfeng agents only when signal warrants it.

| Factor | Threshold | Extra exploration |
|--------|-----------|-------------------|
| Total files | >100 | +1 structure agent per 100 files |
| Code lines | >10k | +1 hotspot agent per 10k lines |
| Directory depth | >=4 | +1 deep-boundary agent |
| Large files | >10 files over 500 lines | +1 hotspot agent |
| Monorepo/workspaces | detected | +1 package-boundary agent per package group |
| Multiple languages | >1 primary language | +1 language-convention agent per extra language |

Scale commands, examples:
  fd -t f -E node_modules -E .git -E dist -E build -E .direnv | wc -l
  fd -t f -e ts -e tsx -e js -e jsx -e py -e go -e rs -e java -e scala -E node_modules -E dist -E build
  rg -n "DO NOT|NEVER|ALWAYS|DEPRECATED|TODO|FIXME" -g '!node_modules' -g '!dist' -g '!build'

### Main Session Discovery

Run while agents work.

1. Existing docs
   - Use fd to locate AGENTS.md and CLAUDE.md.
   - Read root AGENTS.md first, then child docs by path.
   - Extract: commands, ownership, invariants, ask-first zones, never rules, gotchas.
   - Treat CLAUDE.md as legacy/context input; AGENTS.md remains output contract.

2. Structure
   - Use fd for files/dirs. Exclude runtime/generated dirs: .git, node_modules, dist, build, coverage, .direnv, caches, session logs.
   - Identify package/workspace roots, entrypoints, config files, test roots, generated assets, vendored code.
   - Keep only non-obvious structure notes for docs.

3. CodeGraph first-class discovery, if available
   - Use CodeGraph for architecture, symbol map, call flow, central modules, impact radius.
   - Good signals: highly-referenced symbols, exported APIs, route/command registrations, event contracts, cross-dir callers/callees.
   - If CodeGraph missing/stale, continue with fd/rg/read. Do not block.

4. LSP first-class discovery, if available
   - Use LSP symbols/references/diagnostics for entrypoints, exported types, centrality, broken imports.
   - Use reference counts as scoring evidence. Use diagnostics only as sanity signal, not as AGENTS content unless workflow-relevant.
   - If LSP unavailable, continue with CodeGraph or rg/fd/read.

5. Text search
   - Use rg for command names, TODO/FIXME, comments with MUST/NEVER/DEPRECATED, event names, env vars, config references.
   - Use fd for exact file discovery. Do not use POSIX find/grep snippets in generated docs.

Collect chengfeng results. Merge: existing docs + structure + CodeGraph + LSP + rg/fd + agent findings. Mark discovery completed.

## Phase 2: Scoring & Location Decision

Mark scoring task in_progress.

### Scoring Matrix

| Factor | Weight | High signal | Source |
|--------|--------|-------------|--------|
| File count | 3x | >20 files | fd |
| Subdir count | 2x | >5 child dirs | fd |
| Code concentration | 2x | >70% code or dense module | fd/rg |
| Distinct commands/config | 3x | own package/config/test command | files/read |
| Ownership boundary | 3x | package, extension, app, service, domain module | structure/docs |
| Unique conventions | 2x | rules differ from parent | existing docs/rg |
| Hazard density | 2x | destructive ops, generated files, secrets, migrations | rg/read |
| Symbol density | 2x | many exported symbols/types | CodeGraph/LSP |
| Reference centrality | 3x | many callers/references | CodeGraph/LSP |
| Bridge centrality | 3x | connects multiple dirs/events/routes | CodeGraph/LSP/rg |
| Test complexity | 2x | custom stubs/integration harness | tests/config |

### Decision Rules

| Score | Action |
|-------|--------|
| Root | Always create/update |
| >15 | Create/update AGENTS.md |
| 8-15 | Create only if distinct domain or hazard |
| <8 | Skip; parent covers it |

Respect --max-depth=N. Depth is relative to repo root. Never create child docs deeper than requested max depth.

Output working list:
  AGENTS_LOCATIONS = [
    { path: ".", type: "root", reason: "required" },
    { path: "src/api", score: 18, reason: "own API boundary + high centrality" }
  ]

Mark scoring completed.

## Phase 3: Generate AGENTS.md

### Write Root First

Mark root generation in_progress.

Root AGENTS.md must be concise, operational, repo-wide only.

Root template sections:
  # PROJECT_NAME
  Generated, Commit, Branch
  Overview
  Child DOX Index
  Structure
  Where to Look
  Commands
  Always
  Ask First
  Never
  Gotchas
  References

Root quality gates:
- 50-150 lines target. Shorter OK for small repos.
- Exact commands only, sourced from files.
- No generic ecosystem advice.
- Child index includes every child AGENTS.md path, owner doc, scope.
- Push local rules down; do not overload root with child-only facts.

If root AGENTS.md exists, use edit. If absent, use write. Never overwrite an existing file with write.

Mark root generation completed before child work starts.

### Generate Child Docs in Parallel

Mark child generation in_progress.

For each non-root location, launch jintong in background. Give only directory-specific context plus inherited parent summary.

Child prompt shape:
  Agent(subagent_type="jintong", description="Generate AGENTS.md for PATH", run_in_background=true, prompt="TASK: Generate AGENTS.md for PATH. MUST read parent AGENTS chain and local files. Write PATH/AGENTS.md only. Keep 30-80 lines. Include local Overview, Structure if useful, Where to Look, Commands if local, Always, Ask First, Never, Gotchas. Do not repeat parent. Use telegraphic style. Verify with readback.")

Child quality gates:
- 30-80 lines target.
- Local-only rules. Parent duplicates deleted.
- Concrete commands, paths, config names.
- No generic advice. No prose padding.
- No broad rewrites outside target directory.

Collect all child agent results. Mark child generation completed.

## Phase 4: Strict Review, Dedupe, Trim

Mark review task in_progress.

For each generated/updated AGENTS.md:
- Read parent chain and child file.
- Delete parent-child duplicates.
- Delete generic statements true of most projects.
- Delete stale upstream-only or tool-specific instructions not present in this Pi runtime.
- Trim root to 50-150 lines target; child docs to 30-80 lines target.
- Prefer fragments, tables, terse bullets. No filler phrases.
- Validate commands exist in package/config/docs before listing.
- Validate links/paths with fd/read.
- Check no runtime state, secrets, logs, caches, auth files got documented as editable source.
- Check --create-new preserved useful context from previous docs before deletion.

Final pass:
- Root-first hierarchy coherent.
- Child docs do not weaken parent rules.
- AGENTS + CLAUDE discovery reflected only when durable and current.
- Centrality signals used for placement, not dumped as noisy symbol lists.
- If CodeGraph/LSP unavailable, final report says unavailable and lists fallback evidence.

Mark review completed.

## Final Report

Return:
  === init-deep Complete ===
  Mode: update or create-new
  Max depth: N
  Discovery: CodeGraph used/unavailable; LSP used/unavailable; chengfeng agents count
  Files created: N
  Files updated: N
  Files removed: N
  Hierarchy:
    ./AGENTS.md
    child/path/AGENTS.md
  Review: dedupe complete; trim complete; generic content removed
  Notes: blockers or skipped dirs with reasons

## Non-Negotiables

- Root first, children parallel after root.
- Existing AGENTS.md and CLAUDE.md read before writes.
- CodeGraph and LSP are first-class when available, never mandatory when absent.
- Dynamic background exploration scales with project size.
- Scoring includes centrality, not just file counts.
- Child docs never repeat parent docs.
- Generated prose stays telegraphic and project-specific.
- No unsupported tool names as requirements.
`;
