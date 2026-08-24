---
name: ulw-plan
description: ulw-plan UNCLEAR-intent path - the outcome itself is fuzzy; research to best practice, do not interrogate, auto high-accuracy.
metadata:
  short-description: ulw-plan unclear-intent research path
---

# ulw-plan - UNCLEAR intent

Read this when desired OUTCOME is fuzzy: vague request, bootstrap, `/handoff:start-work` without a selectable plan, or a goal the user cannot articulate. Asking the user to design the outcome would offload planner work.

## Research and topology

Research rather than interrogate. Fan out more parallel `chengfeng` and `wenchang` lanes than CLEAR, then independently verify material claims. Every wave names the exact gap it serves. Continue only while a named-gap wave adds material evidence. Stop at sufficiency or after the first wave that adds no new useful fact; never re-explore to double-check.

For Architecture classification, bootstrap, Discord, or external-source requests, conditionally load `references/adversarial-research.md` and run its shared five-phase workflow before synthesis. While active, it may use multiple named phase-specific waves; apply the wider UNCLEAR stop policy to each named gap/phase, stopping at sufficiency or its first no-new-useful-fact wave.

TOPOLOGY LOCK still applies. Announce and record 1-6 independently succeeding/failing components with stable IDs, outcomes, status, and evidence paths. Every todo later traces to one. Preserve requested/evidence-backed scope exactly: never collapse into a reduced subset, phase, or deferral; never expand into adjacent features.

## Defaults and single-question exception

For every open choice, adopt the defensible repo-convention or industry-standard default. Record it in the draft Open-assumptions ledger with rationale and reversibility. Default and announce reversible internals plus cross-cutting choices, including public config, distribution/packaging, external dependency/pin, and data/schema shape.

Ask exactly ONE focused question only when a still-unresolved fork is irreversible, destructive, or safety-critical. No other uncertainty becomes a question. The user may veto announced defaults at approval.

Fold a contrarian self-grill into mandatory `direnjie`: challenge the highest-leverage adopted assumption, distinguish real constraints from habit, and identify complexity unsupported by the request. It may reframe incidental complexity only; it NEVER reduces, phases, defers, or expands requested scope. Adopt a reframe only as an announced default with rationale.

## Review requirement

Non-Trivial UNCLEAR work sets `review_required: true`; after approval, mandatory `direnjie`, and complete plan production, dual fresh `yanluo` + independent `taishang` review runs automatically. Trivial work suppresses automatic dual review but still runs `direnjie` once. An explicit review modifier always requires dual review.

Load `review-lifecycle.md` only when the complete plan makes review actionable. Fix every cited issue and submit both fresh reviewers until both approve.

## Approval and plan

Only when approaching approval, load `full-workflow.md`. Build the pre-plan approval brief from the draft. LEAD with routing and defaults: "I treated this as open-ended and chose defaults; if you had a specific outcome in mind, say so and I will switch to asking." Announce derived approach, exact Components, and every adopted default with rationale/reversibility. Then wait for explicit approval. Do not refer to a plan TL;DR before plan creation.

Approval authorizes plan creation only. After approval, create the plan, copy the same routing statement and adopted defaults from the draft into `## TL;DR (For humans)` under "Decisions I made for you", run mandatory `direnjie`, complete the plan, then run required review. Deliver through `plan_approve`; never execute.

Bootstrap exception: when `/handoff:start-work` invokes this skill because no selectable plan exists, that invocation counts as approval to generate the plan only. After review, call `plan_approve` and stop. Execution starts only if the user invokes `/handoff:start-work` again.

## Worked example

Request: "make auth better".

1. Research current `src/auth/*`, repo-supported improvement needs, and external baseline evidence.
2. Announce topology derived from evidence, such as session hardening, brute-force protection, and password policy. Keep adjacent MFA Scope OUT absent request/evidence.
3. Record and announce reversible defaults, e.g. bcrypt rounds 8 → 12, 5/min-per-IP login limit, and session-ID rotation on privilege change.
4. Present routing/default approval brief → explicit approval → scaffold → mandatory contrarian `direnjie` → complete plan with same defaults in TL;DR → automatic dual review → `plan_approve`.
