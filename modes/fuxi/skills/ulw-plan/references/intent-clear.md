---
name: ulw-plan
description: ulw-plan CLEAR-intent path - the user knows the outcome; ask only the genuine forks, with WHY.
metadata:
  short-description: ulw-plan clear-intent interview path
---

# ulw-plan - CLEAR intent

Read this when routing resolved to CLEAR: the user knows the desired outcome; only repo-unanswerable preferences or tradeoffs remain. The on-the-fence tie-break also enters here and asks exactly one question.

## Research

Explore before asking. Dispatch parallel read-only internal pattern/test-infra and external contract research in one turn; use direct CodeGraph/read/rg/ast/LSP while it runs. For each named open gap, run one sufficient evidence wave. Stop that gap when evidence makes its clearance answerable; never rerun a wave to double-check.

For Architecture classification, Discord, or external-source requests, conditionally load `references/adversarial-research.md` and run its shared five-phase workflow before interview synthesis. That workflow may use multiple phase-specific waves; ordinary CLEAR gaps still use exactly one sufficient wave, and each adversarial phase stops at evidence sufficiency.

Facts-vs-decisions triage precedes the two filters. Repo/system/docs facts are researched and cited, never asked. If only the user can answer, the choice may enter the interview. If ownership is uncertain, treat it as a user decision.

## Topology and owner decisions

TOPOLOGY LOCK first. From request plus evidence, enumerate 1-6 top-level components that can independently succeed or fail. Confirm them in one turn and record each in the draft Components ledger: stable ID, one-line outcome, status, evidence path. Never collapse topology because work looks small.

Apply the two filters from `SKILL.md`. A choice survives as an owner decision only when unresolved evidence leaves either:

- an irreversible, destructive, or safety-critical fork; or
- a cross-cutting product contract: public config surface, distribution/packaging, new external dependency or pin, or data/schema shape.

Reversible internal choices use evidence-backed defaults. Cross-cutting contracts remain questions even when a defensible default exists.

Explicit interview override changes only question selection: disable the adopt-default filter and ASK every surviving repo-unanswerable fork. Research still precedes questions; discoverable facts never become questions.

## Interview

ASK WITH WHY: state what you explored, why evidence did not decide, and which plan segment forks. Ask 1-3 narrow questions per turn, each with 2-4 options and recommended default FIRST; a skipped question adopts that default.

Target the foggiest open gap: choose the gap whose resolution most unblocks the plan, explain why in one sentence, then rotate across equally foggy components. End each turn with the question or explicit next action.

Confirm test strategy every time: `TDD`, tests-after, or none. Agent-executed happy and failure QA remains mandatory regardless.

After each turn, check: objective defined; Scope IN/OUT explicit; approach decided; test strategy confirmed; no blocking ambiguity. Any failure selects the next question. All pass → approach approval.

## Approval and plan

Only when approaching approval, load `full-workflow.md`. Present findings with paths, approach, and every surviving owner decision with recommended option; then wait for explicit approval. If approval would be the only question, recheck for defaults that should have survived.

After approval: create plan scaffold, run mandatory `direnjie`, APPEND todos, fill TL;DR last. If `review_required: true`, load `review-lifecycle.md` and complete dual review before delivery. Otherwise present summary through `plan_approve`. Never execute; only user starts Hou Tu through `/handoff:start-work`.

## Worked example

Request: "add a 5/min-per-IP rate-limit to `/login`".

1. Evidence finds auth middleware at `src/auth/login.ts:40`, limiter utility at `src/util/rate-limit.ts`, and an existing Redis client at `src/redis.ts`.
2. Topology lock records one active component: login rate-limit.
3. Existing Redis is adopted and recorded as the evidence-backed, reversible internal storage default; it is not asked.
4. Ask only a genuine unresolved owner fork, such as the public over-limit response contract, when repo evidence does not decide it: recommended `429 + Retry-After`, alternatives `423` or silent drop.
5. Approval → scaffold → mandatory `direnjie` → plan → required review if applicable → `plan_approve`.
