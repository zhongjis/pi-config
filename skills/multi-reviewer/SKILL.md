---
name: multi-reviewer
description: |
  Multi-model parallel PR review. Spawns multiple LLM reviewers in parallel
  (opus + gpt-5.5) against identical context for one PR, merging findings
  into one GitHub review with consensus, disagreement, and minority sections.

  Use whenever the user asks for multi-model, parallel, panel, cross-model,
  or "second opinion" PR review — even without saying "multi-reviewer".
  Triggers include "panel review", "parallel review", "cross-model review",
  or mentioning two model names alongside PR review.

  Do NOT use for single-model PR review ("review this PR"); defer to the
  `code-review` skill. Requires a GitHub PR reference.
---

# multi-reviewer

Spawn N reviewers in parallel against identical prepared context, then merge
their findings into one GitHub review. The orchestrator (kuafu by default)
gathers context once, fans out to N taishang reviewers — each on a different
LLM — collects results, aggregates them, and posts a single review back to
the PR via `gh`.

## Why this design

The hard part of multi-reviewer review is not running models in parallel —
that is one `Agent` call per reviewer with `run_in_background: true`. The
hard part is making the findings **comparable** and **non-redundant**.

- If each reviewer gathers its own context, three reviewers will see three
  different views of the PR. Findings stop being comparable: opus may flag
  a bug because it read file A; gpt-5.5 may miss the bug because it never
  opened file A. Disagreement becomes noise instead of signal.
- If we re-flag issues already raised by humans or Copilot, the PR author
  drowns. The dedupe corpus makes reviewers respect prior reviewers.
- If we just stack three reports, the reader does the merge work in their
  head. The aggregation phase pays back the parallelism investment.

So this skill enforces three invariants:

1. **Context is gathered once.** Reviewers do not delegate to other agents.
2. **Reviewer prompts are identical bytes.** Only `model:` differs.
3. **Aggregation is mandatory.** Output is one review, structured.

## When to use vs defer

Use this skill only when the user explicitly invokes multi-model semantics
on a pull request. For everything else, defer:

| Request | Skill |
|---|---|
| "multi-review PR 123", "panel review", "have GPT also review" | this skill |
| "review this PR", "look at PR 123" | `code-review` skill |
| Local diff (no PR reference) | inline taishang consult during build flow |
| Branch-vs-base review without GitHub PR | not supported here |

## Phase A — Prepare context (orchestrator, sequential)

The orchestrator gathers everything once. Reviewers are read-only and never
delegate. All steps below run before any reviewer is spawned.

### A.1 Resolve PR reference

```bash
gh pr view "$PR_REF" --json number,title,body,labels,baseRefName,headRefName,headRefOid,author,url
```

`$PR_REF` is whatever the user gave: PR number, branch name, or full URL.
Capture `headRefOid` as `$HEAD_SHA`. Fork PRs work via `refs/pull/${N}/head`
in A.2, so no fork-repo URL is needed.

### A.2 Establish a PR-head worktree

Create one ephemeral git worktree at the PR head SHA, **shared by all
reviewers and chengfeng**. Reviewers are read-only so they can safely share
a single worktree — no need for per-reviewer isolation.

```bash
WT="$(mktemp -d)/pr-${N}-worktree"

# Fetch the PR head into a local ref. Works for same-repo and fork PRs.
git fetch origin "+refs/pull/${N}/head:refs/remotes/origin/pr-${N}"

# Detached worktree at the exact PR head SHA.
# --detach avoids "branch already checked out elsewhere" failures.
git worktree add --detach "$WT" "$HEAD_SHA"

# Cleanup trap — runs on success AND failure.
trap "git worktree remove --force '$WT' >/dev/null 2>&1 || true" EXIT
```

**Why detached at SHA, not branch:** if the user already has another
worktree on the same branch, `git worktree add … "$BRANCH"` fails. Detaching
at the SHA always works and pins reviewers to the exact commit being
reviewed even if new commits land mid-review.

All later commands (`gh api …` for diff and content also work without it,
but rg/grep/build commands run by chengfeng or fallback paths) MUST run
with `cwd: $WT`. Reviewer subagents are told this explicitly in their
prompt.

### A.3 Build the dedupe corpus

Pull existing review state so reviewers do not re-flag known issues:

```bash
# Inline review comments (file:line threads)
gh api "repos/$OWNER/$REPO/pulls/$N/comments" --paginate

# Review summaries (overall verdicts and bodies)
gh api "repos/$OWNER/$REPO/pulls/$N/reviews" --paginate
```

Distill into a flat "Already Raised" list. Format:

```
- src/auth.ts:42 — null check missing on token (Copilot, 2 days ago)
- src/db.ts:118 — query timeout not configured (alice, yesterday)
```

Keep enough context (path, line, one-sentence summary, reviewer, age) for
reviewers to recognize the issue without reading the whole thread.

### A.4 Fetch the diff

```bash
gh pr diff "$PR_REF"
```

Unified diff of the PR. Pass through verbatim. Equivalent to
`git -C "$WT" diff "$BASE_SHA"…"$HEAD_SHA"` if you prefer to avoid an extra
gh round-trip.

### A.5 Read full content of changed files (from worktree)

For each file in the diff, read its content from `$WT` directly. The
worktree is already pinned to the PR head SHA, so this avoids per-file
`gh api` round-trips:

```bash
# Read all changed files in one shell round-trip; markers let downstream
# parsing split them. Skip binaries and files >50KB.
for path in $CHANGED_FILES; do
  [ -f "$WT/$path" ] || continue
  size=$(wc -c < "$WT/$path")
  [ "$size" -gt 51200 ] && continue
  printf '\n=== FILE: %s ===\n' "$path"
  cat "$WT/$path"
done
```

Skip binary files and any file over a sensible cap (e.g., 50KB).

**Aggregate context budget**: cap total prepared-context file content at
~500KB (separate from diff + metadata). Reviewer prompts are identical
bytes across models (Invariant #2), so the cap is a single global value —
not model-aware.

Priority for inclusion (descending):
1. Production-code files, ordered by changed-line count.
2. Test files, ordered by changed-line count.

Drop from the bottom until under budget. Files dropped from full-content
inclusion remain visible via the diff in A.4. Add a "Truncated for context
budget" subheader to the prepared-context blob listing dropped paths so
reviewers know what is missing.

### A.6 Optional caller map (chengfeng)

Skip caller map when ANY is true:

- Diff touches ≤2 files AND ≤50 changed lines.
- All changes are in test files.

Otherwise spawn `chengfeng` in the background **immediately after the
diff is fetched in A.4** so it runs concurrent with A.5 file reads. Do
NOT wait inline — `get_subagent_result(wait=true)` is called once at the
start of A.7 to join.

```
Agent(
  subagent_type="chengfeng",
  description="Trace callers at PR head",
  run_in_background=true,
  prompt=`Trace callers and dependents of the symbols changed in PR #${N}.

WORKING DIRECTORY: ${WT}
This is a detached git worktree at the PR head SHA (${HEAD_SHA}).
Pass cwd: ${WT} to ALL bash/rg/grep/find commands. Do NOT search in
any other directory — the user's main worktree may be on a different
branch and would give false results.

Symbols to trace: <list extracted from the diff>
Return: each symbol → list of path:line callers + dependents at PR head.`
)
```

Join chengfeng at the top of A.7 via
`get_subagent_result(agent_id=<id>, wait=true)`. If chengfeng times out
or fails, proceed without the caller map and note its absence in the
prepared-context blob (`## Caller Map` → `not available`).

### A.7 Assemble prepared-context blob

Single markdown document, structured with stable section headers so
reviewers can navigate. **All reviewers receive identical bytes.**

```markdown
# PR Review Context

## Metadata
- Number: 123
- Title: ...
- Author: ...
- Base: main
- Head: feature/auth (sha: abc123)
- Labels: ...
- URL: ...
- Worktree path: /tmp/.../pr-123-worktree
- Body:
  ...

## Already Raised (do NOT re-flag)
- src/auth.ts:42 — null check missing (Copilot, 2 days ago)
- ...

## Diff
```diff
<unified diff>
```

## Changed Files (full content at PR head)

### src/auth.ts
```typescript
<full file content from $WT>
```

### src/db.ts
```typescript
<full file content from $WT>
```

## Caller Map (optional)
- `getUserFromToken` (src/auth.ts) — called by:
  - src/middleware/session.ts:14
  - src/api/login.ts:33
- ...
```

## Phase B — Parallel fan-out (orchestrator, parallel)

### Model roster — exact identifiers (v1 default)

Pi resolves `model:` two ways: exact `provider/modelId`, or fuzzy alias
(e.g., `sonnet`). **Use exact identifiers.** Bare aliases like `gpt-5`
silently fall back to the parent's default model when the alias does not
match any registered model — that is the failure that caused both
reviewers to run on opus in the very first test.

Default roster:

- `anthropic/claude-opus-4-7`
- `openai-codex/gpt-5.5`

These match the providers configured in `agents/kuafu.md`. If the user's
pi setup uses different provider IDs, they MUST be passed as overrides;
do not guess.

**User overrides:** if the user names models in the request (e.g.,
"review with sonnet and gpt-5.5", "panel-review with claude + codex"),
resolve to the corresponding exact IDs from the user's pi configuration
and use those instead of the default roster.

**Thinking level:** pass `thinking: "high"` to both reviewers. This
matches kuafu's own thinking level and gives a fair fight between models.

### B.1 Spawn reviewers in one message

All `Agent` calls in the SAME assistant message so they run truly
parallel:

```
Agent(
  subagent_type="taishang",
  description="opus PR review",
  model="anthropic/claude-opus-4-7",
  thinking="high",
  run_in_background=true,
  prompt=<reviewer-prompt>,
)
Agent(
  subagent_type="taishang",
  description="gpt-5.5 PR review",
  model="openai-codex/gpt-5.5",
  thinking="high",
  run_in_background=true,
  prompt=<reviewer-prompt>,
)
```

`<reviewer-prompt>` is identical bytes for every reviewer.

### B.2 Reviewer prompt template

Build once; pass to every reviewer:

```
TASK: Review the prepared PR context below and produce structured findings.

EXPECTED OUTCOME: A markdown report with three sections in this exact order:

VERDICT: APPROVE | REQUEST_CHANGES | COMMENT

FINDINGS:
- [SEVERITY] path:line — short title
  Issue: what is wrong (1–2 sentences, grounded in the file content).
  Why it matters: concrete impact (1–2 sentences).
  Suggestion: a specific fix — code snippet or precise instruction. Skip
    only for [NIT] / [KUDOS].
  confidence: 1–5

SUMMARY: 2–3 sentences capturing your overall take. End with `overall confidence: N/5`.

WORKING DIRECTORY: <$WT>
This is a detached git worktree at the PR head SHA. If you need to read
any file outside the prepared context, read it from this directory and
pass cwd: <$WT> to any shell command. Do NOT read or search outside it.

REQUIRED TOOLS: read only.

REVIEW DIMENSIONS — examine each dimension explicitly. Skip a dimension only
if it does not apply to the diff. Do NOT skip dimensions silently.

| Dimension | What to look for |
|---|---|
| Correctness    | Logic errors, off-by-one, null/undefined handling, edge cases, boundary conditions |
| Security       | Input validation, injection (SQL/XSS/command), auth/authz gaps, secrets exposure, OWASP top 10 |
| Performance    | N+1 queries, heavy allocations in loops, algorithm complexity, resource leaks, missing pagination |
| Concurrency    | Races, deadlocks, unsafe shared mutable state, missing locks/atomics |
| Error Handling | Swallowed exceptions, missing error context, improper propagation, empty catch blocks |
| Testing        | Coverage of new logic, edge case tests, meaningful assertions (not just existence) |
| Observability  | Logging for debugging, metrics for monitoring, tracing in distributed paths |
| Code Quality   | Naming clarity, function length/complexity, DRY violations, single responsibility |

SEVERITY tags (use these exact labels):
- [BLOCKER]    — security vuln, data loss, crash, correctness bug. Must fix before merge.
- [MAJOR]      — logic error, missing edge case, architectural violation, missing tests. Must fix or justify.
- [SUGGESTION] — refactor, readability, optimization. Recommended, not blocking.
- [NIT]        — style, naming preference, trivial formatting. Optional.
- [KUDOS]      — exemplary code, clever solution, good pattern. Recognition only.

CONFIDENCE rubric (per finding AND overall review):
- 5/5 — verified end-to-end; can point to the exact failure mode.
- 4/5 — strong pattern match; one or two hops left untraced.
- 3/5 — moderate complexity; some logic paths or side effects unclear.
- 2/5 — significant uncertainty or domain unfamiliarity.
- 1/5 — speculative; likely issues missed.

Subtract 1 from overall confidence for each that applies: DB migrations,
auth/security logic, complex concurrency, large cross-cutting refactor,
missing test coverage, unfamiliar domain.

MUST DO:
- Focus on the diff. Flag pre-existing issues only if directly impacted by the change.
- Ground every finding in actual file content from the prepared context or the worktree at <$WT>.
- Use exact path:line(s) references; multi-line findings include a line range.
- Be dense. One reader-actionable insight per finding. ~5–15 substantive findings is typical for a non-trivial PR; do NOT pad.
- For [BLOCKER] / [MAJOR] / [SUGGESTION], include a concrete fix (snippet or precise instruction) — not just "consider X".
- Skip anything in "Already Raised".
- Use [KUDOS] sparingly to highlight patterns worth reinforcing.

MUST NOT DO:
- Delegate to chengfeng, wenchang, or any subagent. Context is provided.
- Modify any file.
- Speculate beyond the prepared context. If you cannot tell, say so explicitly and lower confidence.
- Re-raise issues already in "Already Raised".
- Read or search outside <$WT>; the user's main checkout may be on a different branch and would give false results.
- Pad with low-value nits to inflate findings count.

CONTEXT:
<prepared-context blob from Phase A>
```

### B.3 Collect results

Fire `get_subagent_result(wait=true)` for each reviewer in the SAME
assistant message — both block in parallel and return when their reviewer
completes. This avoids the polling-loop turn churn.

```
get_subagent_result(agent_id=<id_1>, wait=true)
get_subagent_result(agent_id=<id_2>, wait=true)
```

Pi's Agent supervision enforces internal deadlines per reviewer. If a
reviewer is still running after ~15 min and the orchestrator is
concerned about drift, use `steer_subagent` with a concrete narrowing
instruction; otherwise let `wait=true` hold.

Failure handling:

- **One reviewer fails / times out** → continue with the rest. Note the
  failure in the final review summary ("model X did not return; review
  is based on N–1 reviewers").
- **All reviewers fail or time out** → abort. Do NOT post a one-sided
  or empty review. Report the failure to the user.

### B.4 Sanity check — distinct effective models

Pi can silently fall back to a default model when a `model:` string fails
to resolve. **Verify both reviewers ran on different models before
aggregating.**

Each `get_subagent_result` payload reports the agent's effective model.
Compare across reviewers:

- If all reviewers report identical effective models → **abort
  aggregation and tell the user**. Do not post a review backed by a
  single model masquerading as multiple. Surface the requested-vs-actual
  model mismatch so the user can fix their pi provider config.
- If one or more reviewers ran on a different model than requested but
  the set is still distinct → continue, but note the substitution in
  the final review summary.

This is the load-bearing safeguard against the "both on opus" failure
mode.

## Phase C — Aggregate (orchestrator, inline)

The orchestrator reads all N reports and merges them. Clustering uses LLM
judgment — there is no shared finding ID across reviewers.

### C.1 Reconcile against Already Raised

Before clustering, classify each finding against the A.3 list:

- **DROP** — path matches AND line within ±3. Same bug at the same place.
  Log as "Filtered: N findings already raised."
- **ECHO** — path matches but line differs by more than ±3. Surface in
  the Minority Views section with prefix `[echo of prior review by X]`.
  Reader can decide whether it is the same issue restated or a new one
  nearby.
- **KEEP** — path does not match. Pass through to clustering unchanged.

No fuzzy title match. Prior-review summaries are short and share
vocabulary on common defect classes (null checks, races, leaks); fuzzy
matching causes false drops that hide signal. Explicit echo tagging
surfaces signal instead.

This is the enforcement layer for the dedupe corpus from A.3. The
reviewer-side "skip Already Raised" instruction is best-effort; this
filter is authoritative.

### C.2 Cluster cross-reviewer findings

**Step 1 — Normalize each finding before clustering:**

- Strip leading `./` and any `a/`/`b/` diff prefixes from `path`.
- Detect renames: parse `gh pr diff` for `rename from X` / `rename to Y`
  pairs and treat findings against either side as the same canonical
  path (use `Y`, the new path).
- Use `(path, primary_line)` as the cluster key; `primary_line` is `line`
  for single-line findings, `start_line` for multi-line.

**Step 2 — Cluster heuristic:**

- Two findings cluster if they reference the **same canonical path**,
  with `primary_line` ranges within ±5 lines, and titles describe the
  same defect class (null safety, race, leak, validation gap, etc.).
- **If uncertain, prefer NOT clustering.** False consensus hides
  disagreement under a fake majority signal; fragmented minorities are
  noisy but visible.

**Worked examples:**

1. *Same bug, different phrasing* — opus says `src/auth.ts:42 — null deref on token`,
   gpt-5.5 says `src/auth.ts:42 — missing undefined guard for token`.
   → Cluster (Consensus). Same file, same line, same defect class.

2. *Adjacent unrelated bugs* — opus says `src/db.ts:118 — missing query timeout`,
   gpt-5.5 says `src/db.ts:122 — wrong index used`.
   → DO NOT cluster despite proximity. Different defect classes.
   Both surface as Minority views.

3. *Renamed file mid-PR* — opus says `src/auth.ts:42`, gpt-5.5 says
   `src/security/auth.ts:42`. Step 1 rename detection canonicalizes both
   to the new path → cluster. If no `rename from` header, leave as 2
   minorities.

For each cluster:

| Cluster shape | Section | Note |
|---|---|---|
| ≥2 reviewers flagged | **Consensus** | use the highest severity |
| 1 reviewer flagged + others addressed but disagreed (different severity or "this is fine") | **Disagreement** | show both sides |
| 1 reviewer flagged + others silent | **Minority view** | tag with model name |

### C.3 Output structure

```markdown
## Consensus Findings (≥2 reviewers agreed)

[BLOCKER] src/auth.ts:42 — null deref on token  (opus + gpt-5.5)
Issue: token may be undefined when the refresh path is taken; calling .userId throws.
Why it matters: every refresh request 500s in production.
Suggestion: guard with `if (!token) return unauthorized();` before line 42.
confidence: 5/5 (opus), 4/5 (gpt-5.5)

...

## Disagreements

src/db.ts:118 — query timeout missing
- opus: [BLOCKER] 4/5 — production traffic spikes will time-block the loop
- gpt-5.5: [NIT] 3/5 — defaults are fine for current load

...

## Minority Views

[MAJOR, opus only] src/api/login.ts:55 — rate-limit bypass via nested header
gpt-5.5 did not flag. Worth a closer look. confidence: 4/5.

...

## Kudos (optional)

[KUDOS] src/utils/retry.ts — clean exponential backoff with jitter (gpt-5.5)

## Reviewer Verdicts
- opus: REQUEST_CHANGES (overall confidence: 4/5)
- gpt-5.5: COMMENT (overall confidence: 3/5)

## Summary
8 findings: 3 consensus, 2 disagreements, 3 minority. Verdict: REQUEST_CHANGES.
```

### C.4 Verdict reconciliation

Deterministic — no LLM judgment. Conservative by design — a single
high-confidence flag from any reviewer drives `REQUEST_CHANGES`;
silence is not approval.

| Condition | Final verdict |
|---|---|
| Any reviewer flagged `[BLOCKER]` or `[MAJOR]` (consensus, disagreement, or minority) | `REQUEST_CHANGES` |
| Otherwise | `COMMENT` |

**Never auto-`APPROVE`.** Multi-reviewer does not unilaterally approve.
The floor verdict is `COMMENT` even when every reviewer's individual
verdict is `APPROVE` — humans should explicitly approve PRs.

## Phase D — Post review to GitHub

One atomic `POST` per run. Each invocation creates a new review thread on
the PR; idempotency is the user's responsibility.

### D.1 Validate and map findings to inline comments

Inline comments are only for **Consensus findings whose line falls
within the PR diff hunks**. Disagreements and minority views go in the
summary body. Findings outside diff hunks (e.g., a consensus issue in
unchanged context) also go in the body — GitHub rejects the entire
review payload if any single inline comment line is out-of-range, so
this validation must happen *before* the POST.

**Hunk parse** (POSIX awk — no gawk extensions; runs on macOS BSD awk):

```bash
# Build {file → [(right_start, right_end), ...]} from the diff
gh pr diff "$PR_REF" | awk '
  /^diff --git/ {
    sub(/^diff --git /, "")
    sub(/.* b\//, "")
    file = $0
    next
  }
  /^@@ / {
    s = $0
    sub(/.*\+/, "", s)
    sub(/ .*/, "", s)
    n = split(s, a, ",")
    start = a[1] + 0
    len = (n == 2 ? a[2] + 0 : 1)
    print file "\t" start "\t" (start + len - 1)
  }'
```

For each consensus finding:

- If `line` (and `start_line` if present) falls within at least one
  hunk range for `path` on the RIGHT side, emit as inline comment.
  For multi-line, both `start_line` and `line` MUST fall within the
  same hunk; otherwise demote.
- Otherwise demote to the body under a `## Findings outside diff hunks`
  subsection. Log demotions in the run summary.

Inline comment shape:

```json
{
  "path": "src/auth.ts",
  "line": 42,
  "side": "RIGHT",
  "body": "[BLOCKER] null deref on token (opus + gpt-5.5)\n\nToken may be undefined when refresh path is taken; calling .userId throws.\n\nconfidence: high"
}
```

If the finding spans multiple lines, use `start_line` + `start_side: "RIGHT"`
in addition to `line` + `side: "RIGHT"`.

### D.2 Build review payload

```json
{
  "commit_id": "<HEAD_SHA from Phase A.1>",
  "event": "REQUEST_CHANGES",
  "body": "<aggregated markdown — Phase C output>",
  "comments": [
    { "path": "...", "line": ..., "side": "RIGHT", "body": "..." },
    ...
  ]
}
```

### D.3 Post

```bash
gh api "repos/$OWNER/$REPO/pulls/$N/reviews" \
  --method POST \
  --input /tmp/multi-review-payload.json
```

If the post fails (line mapping mismatch, network, auth), surface the
exact error and the payload path. Do NOT retry automatically — the user
should inspect what failed.

## Failure handling summary

| Failure | Behavior |
|---|---|
| One reviewer fails | continue with rest, note in summary |
| All reviewers fail | abort, do not post |
| Reviewers report identical effective models (B.4) | abort, surface model resolution mismatch |
| Only one provider configured | abort, tell user |
| `git worktree add` fails (dirty parent, missing fetch ref, etc.) | abort early with clear error |
| Inline comment line mapping rejected | abort post, surface error + payload path |
| `gh` not authenticated | abort early (Phase A.1 will fail clearly) |

## Re-run policy (v1)

Each invocation posts a NEW review to the PR. No deduplication against
prior multi-reviewer runs. If this becomes annoying, a future version
can either update the prior review or abort if a recent multi-reviewer
review already exists.

## Non-goals

- **Local-diff orchestration** — covered by inline taishang consult
  during the build flow, not this skill.
- **Per-model prompt variants** — single prompt is the v1 invariant.
  Empirically tune later if quality gap is material.
- **Houtu / PLAN.md execution** — orchestrator-as-skill is sufficient
  for v1.
- **Migration to nicobailon chain mode** — same reason.
- **Prompt template `/multi-review`** — withdrawn in design.
  Description-based triggering is the v1 strategy.
- **Updating the existing `code-review` skill** — out of scope.

## Future work

- **Empirical description tuning** via the `skill-creator` skill's
  `scripts/run_loop`. Build 20 eval queries (10 multi-model trigger
  cases + 10 near-miss single-model cases that should defer to
  `code-review`), iterate the description against them, pick the
  test-set winner.
- **Cross-provider taishang during build flow** (separate concern;
  belongs in `agents/kuafu.md` and `agents/houtu.md` "Taishang
  discipline" sections, not here). Lets the building agent get a
  fresh-model sanity check on its own work.
- **Re-run dedupe** — if invoked twice on the same PR, update the
  prior review instead of stacking a second one.
- **N > 2 reviewers** — current default is two. Adding a third
  (e.g., another model) is purely a roster change; aggregation
  already handles arbitrary N.
