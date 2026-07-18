# 1. Orchestration task sizing follows upstream omo (no worker file-count guard)

Status: shipped
Date: 2026-07-17
Related: GitHub issue #10 — "Fix Fu Xi/Hou Tu oversized-task orchestration deadlock"

## Context

Hou Tu (execution mode, adapted from upstream omo's Atlas orchestrator) deadlocked in a
real session: 70 of 74 logical tasks unfinished with no technical or external blocker
(issue #10). The cause was a prompt-contract collision, not a pi-tasks bug:

- Pi added a **worker scope guard** — `agents/jintong.md` / `agents/juling.md`:
  "multiple domains, more than 3 expected product files, or unclear boundaries → stop
  before edits and propose a smaller split" — plus a matching "≤3 expected product files"
  sizing proxy in the Fu Xi planner, the Kua Fu / Hou Tu orchestrators, and the
  `modes/AGENTS.md` contract. **Upstream omo has no such guard** (verified against the
  pinned baseline in `docs/references/omo-prompts/` and upstream Sisyphus-Junior).
- Hou Tu kept Atlas's post-delegation rule verbatim: "after EVERY verified `Agent`
  completion → mark the pi-task completed + check the PLAN box + do not launch the next
  task first."
- When a plan item exceeded 3 files the worker rejected it, so Hou Tu manually carved it
  into bounded slices. Each slice returned `COMPLETED`, which the Atlas rule treats as a
  logical-task completion — but the item was not done. Marking it complete was false; not
  marking it forbade the next slice. Deadlock.

Upstream never hits this because it has no worker guard: one plan item = one worker
session, resumed in place (`Agent(resume)`) until the whole item verifies. A "successful
partial slice that must not flip the checkbox" cannot occur, so the same Atlas rule is safe.

## Decision

Fix the Pi adaptation to **restore upstream's invariant** rather than add new executor
machinery:

1. Remove the file-count / multi-domain **rejection** from `jintong` / `juling`. Keep only
   a genuine-ambiguity valve (returns `BLOCKED`, makes no edits). Partial work returns
   `BLOCKED` with a resume anchor and is never reported as `COMPLETED`.
2. Keep Hou Tu's Atlas post-delegation rule and Section 3.5 resume-in-place **verbatim**.
   Reword only the delegation-sizing sentence to forbid re-splitting a plan item: an
   over-large item runs as one resumable worker session continued with `Agent(resume)`
   until its whole requirement verifies.
3. Size by **upstream granularity** — one domain / one deliverable, target 5-8 todos per
   wave, split by domain or coupling, **not by a fixed file count** — in the Fu Xi ulw-plan
   skill, the Kua Fu / Hou Tu orchestrators, and `modes/AGENTS.md`. Keep the ~60-tool-call
   ceiling and the tightly-coupled exception (ordered substeps, green checkpoint, turn/tool
   ceiling, resume anchor) as the recoverable handling for genuinely large indivisible work.

This **reverses issue #10's stated non-goal "do not weaken worker scope limits."** The
guard was a mitigation for workers choking on large tasks; it caused the deadlock and
diverged from upstream. The large-task concern is instead handled the upstream way:
plan-time granularity + per-run turn/tool ceilings + resume-in-place.

## Consequences

- The deadlock cannot recur: one plan item maps to one resumable worker session, so a
  verified `Agent` completion only occurs when the whole item is done and the Atlas rule
  fires exactly once. Locked by `test/houtu-slice-deadlock.test.ts`.
- Hou Tu stays faithful to upstream Atlas (rule kept verbatim); the fix removes a
  divergence instead of adding Pi-specific slice-lifecycle machinery.
- Reliance on `Agent(resume)` increases. The secondary defect noted in issue #10 (a stale
  `Agent(resume)` returning a prior completed summary) is now load-bearing and should be
  fixed as a follow-up.
- Worker self-protection against runaway scope is now the planner's + harness turn
  ceiling's responsibility, not the worker's. The worker `<critical>` scope-containment
  rule ("stay inside assigned scope") remains.

## Alternatives considered

- **Issue #10's original direction — keep the guard, teach Hou Tu a slice lifecycle**
  (rewrite "after every verified Agent completion" → "after every verified logical
  plan-task completion" + an explicit partial-slice path). Rejected: it rewrites the
  inherited Atlas rule (less faithful) and adds executor machinery upstream never needed,
  purely to preserve a guard that is itself the divergence.
- **Keep the file-count proxy as a soft hint.** Rejected: leaving it in the planner while
  removing it from the worker is inconsistent and keeps a brittle proxy upstream does not
  use.
