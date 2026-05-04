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
gh pr view "$PR_REF" --json number,title,body,labels,baseRefName,headRefName,headRefOid,author,url,headRepository
```

`$PR_REF` is whatever the user gave: PR number, branch name, or full URL.
Capture `headRefOid` as `$HEAD_SHA` and `headRepository.url` as `$HEAD_REPO`
(needed for fork PRs in the next step).

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
cat "$WT/$path"
```

Skip binary files and any file over a sensible cap (e.g., 50KB).

### A.6 Optional caller map (chengfeng)

For non-trivial PRs, spawn `chengfeng` in the background to identify
callers and dependents of changed symbols. Skip for tiny diffs (one
file, one function).

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

Wait for chengfeng before assembling prepared context.

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
- `openai-code/gpt-5.5`

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
  model="openai-code/gpt-5.5",
  thinking="high",
  run_in_background=true,
  prompt=<reviewer-prompt>,
)
```

`<reviewer-prompt>` is identical bytes for every reviewer.

### B.2 Reviewer prompt template

Build once; pass to every reviewer:

```
TASK: Review the prepared PR context below. Produce structured findings.

EXPECTED OUTCOME: A markdown report with three sections in this exact order:

VERDICT: APPROVE | REQUEST_CHANGES | COMMENT

FINDINGS:
- [SEVERITY] path:line — title
  body (1–4 sentences)
  confidence: high | medium | low

SUMMARY: 2–3 sentences capturing your overall take.

SEVERITY values: BLOCKER | HIGH | MEDIUM | LOW | NIT

WORKING DIRECTORY: <$WT>
This is a detached git worktree at the PR head SHA. If you need to read
any file outside the prepared context, read it from this directory and
pass cwd: <$WT> to any shell command. Do NOT read or search outside it.

REQUIRED TOOLS: read only.

MUST DO:
- Ground every finding in actual file content from the prepared context
  or the worktree at <$WT>.
- Skip anything in "Already Raised" — those are not your findings.
- Use exact path:line(s) references; reviewers downstream rely on them.
- Be dense. One reader-actionable insight per finding.

MUST NOT DO:
- Delegate to chengfeng, wenchang, or any subagent. Context is provided.
- Modify any file.
- Speculate beyond the prepared context. If you cannot tell, say so.
- Re-raise issues already in "Already Raised".
- Read or search outside <$WT>; the user's main checkout may be on a
  different branch and would give false results.

CONTEXT:
<prepared-context blob from Phase A>
```

### B.3 Collect results

Poll all reviewer agents:

```
get_subagent_result(agent_id=<id>, wait=true)
```

Failure handling:

- **One reviewer fails / times out** → continue with the rest. Note the
  failure in the final review summary ("model X did not return; review
  is based on N–1 reviewers").
- **All reviewers fail** → abort. Do NOT post a one-sided or empty review.
  Report the failure to the user.

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
judgment — there is no shared finding ID across reviewers. Heuristic:

- Two findings cluster if they reference the **same file**, with line
  ranges within ±5 lines, and titles describe the same defect class
  (null safety, race, leak, etc.).

For each cluster:

| Cluster shape | Section | Note |
|---|---|---|
| ≥2 reviewers flagged | **Consensus** | use the highest severity |
| 1 reviewer flagged + others addressed but disagreed (different severity or "this is fine") | **Disagreement** | show both sides |
| 1 reviewer flagged + others silent | **Minority view** | tag with model name |

### C.1 Output structure

```markdown
## Consensus Findings (≥2 reviewers agreed)

[BLOCKER] src/auth.ts:42 — null deref on token  (opus + gpt-5.5)
Token may be undefined when refresh path is taken; calling .userId throws.
confidence: high

...

## Disagreements

src/db.ts:118 — query timeout missing
- opus: BLOCKER (high) — production traffic spikes will time-block the loop
- gpt-5.5: NIT (medium) — defaults are fine for current load

...

## Minority Views

[HIGH, opus only] src/api/login.ts:55 — rate-limit bypass via nested header
gpt-5.5 did not flag. Worth a closer look.

...

## Reviewer Verdicts
- opus: REQUEST_CHANGES
- gpt-5.5: COMMENT

## Summary
8 findings: 3 consensus, 2 disagreements, 3 minority. Verdict: REQUEST_CHANGES.
```

### C.2 Verdict reconciliation

Deterministic — no LLM judgment.

| Condition | Final verdict |
|---|---|
| Any consensus `BLOCKER` or `HIGH` | `REQUEST_CHANGES` |
| Any disagreement on `BLOCKER`/`HIGH` (one flags, other doesn't) | `REQUEST_CHANGES` (conservative) |
| Otherwise | `COMMENT` |

**Never auto-`APPROVE`.** Multi-reviewer does not unilaterally approve.
The floor verdict is `COMMENT` even when every reviewer's individual
verdict is `APPROVE` — humans should explicitly approve PRs.

## Phase D — Post review to GitHub

One atomic `POST` per run. Each invocation creates a new review thread on
the PR; idempotency is the user's responsibility.

### D.1 Map findings to inline comments

Inline comments are only for **Consensus findings**. Disagreements and
minority views go in the summary body to avoid spamming the PR author
with noisy threads.

For each consensus finding:

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
