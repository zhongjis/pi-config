<!-- Pi adaptation; provenance and pinned baseline are recorded in `full-workflow.md`. -->

# -plan — UNCLEAR intent

Read this when routing resolves to **UNCLEAR**: the desired outcome itself is fuzzy — a vague brief, bootstrap, missing selectable plan, or goal the user cannot yet articulate. Asking the user to design the outcome would offload the planner’s job onto them. Read sibling `full-workflow.md` before plan generation.

## Stance

**PRIME DIRECTIVE: do not interrogate the user.** Resolve ambiguity through research. Act as a consultant who does the homework and announces defensible best-practice defaults, not a form the user must fill in.

Ask exactly one focused question only when an irreversible, destructive, or safety-critical decision remains after research. Resolve everything else from repository evidence, primary sources, and best practice; record it for user veto at the gate.

**Full-scope anti-reduction is absolute.** Plan the entire evidence-backed request. Never invent or propose an MVP, v1, phase 1, reduced subset, partial rollout, deferral, or “start small” option. Never use uncertainty as permission to omit a requested capability. Scope OUT excludes adjacent features unsupported by the request or evidence; it must not reduce the request itself.

## Research protocol

Fan out wider than CLEAR. Run parallel read-only `chengfeng` lanes for repository structure, patterns, tests, and impact, plus `wenchang` lanes for official docs, external contracts, and source-traced best practices. Continue direct investigation while they run.

Use CodeGraph for broad architecture, flow, ownership, callers, and impact. Use LSP for exact symbol definitions, references, implementations, types, and diagnostics. Use `rg`, `fd`, and `read` for literal/config/file evidence. Every codebase claim must trace to direct evidence or a verified delegated finding; delegated output alone is a claim.

For architecture, bootstrap, or external-source work, run the five-lane adversarial workflow from `full-workflow.md`: repository implementation surface; tests/package surface; external claims; execution workflow; risk/QA. Process them through collect → verify → design → adversarial → synthesize. Reject dirty-worktree overwrite risk, stale state, grep-only QA, misleading success output, and worker self-approval.

Stop when the clearance check is answerable or after two research waves add no useful facts. Never re-explore merely to double-check.

**TOPOLOGY LOCK still applies.** Enumerate 1–6 independently succeeding/failing components into `local://DRAFT.md`; every todo traces to one. Components must refine the full requested or evidence-backed outcome. A vague request must neither collapse into an invented reduced subset nor expand into unsupported adjacent features.

## Default selection

For each open decision, adopt the defensible default from repository convention or industry best practice. Record it in the draft’s Open Assumptions ledger with rationale and reversibility. The ledger is the audit trail; do not replace it with numeric scoring.

Escalate only an irreversible, destructive, or safety-critical default that research cannot settle, using one focused question. Public config, packaging, external dependencies, and data/schema choices may be owner-decisions when they cross that threshold.

Fold a contrarian self-grill into the fresh Di Renjie review:

- Is the highest-leverage assumption supported by evidence, or merely habitual?
- Does a default add incidental complexity the request never asked for?
- Is there a simpler implementation that still delivers the entire requested outcome?

The grill targets incidental complexity only. It must never reduce, phase, defer, or drop requested functionality. Fold any reframe into the plan as an announced default with rationale and reversibility, never as a silent change.

## High accuracy is automatic here

Because the user did not steer the open decisions, adversarial review substitutes for the skipped interview.

Fresh Di Renjie gap analysis always runs during plan generation. After findings are folded and `local://PLAN.md` is complete — including all todos and the human-first TL;DR filled last — automatically dispatch one fresh `yanluo` and one independent fresh `taishang` with `inherit_context=false` against the complete plan. Both must return unconditional OKAY. Fix every issue from either, update the plan, and resubmit BOTH fresh until both approve. Record both receipts and the fix/retry summary in `local://DRAFT.md`.

**TRIVIAL-TIER GUARD:** if classification is Trivial, suppress the automatic dual high-accuracy loop; Di Renjie still runs once. UNCLEAR increases research and default-selection rigor but does not make tiny work expensive. If `review_required: true`, that explicit request overrides the suppression.

After both reviewers return OKAY, call `plan_approve({ variant: "post-high-accuracy" })`. Never infer the user’s approval.

## Approval gate

Still present a brief and wait for the user’s explicit okay before writing `local://PLAN.md`. Approval is not execution.

Lead with the derived best-practice approach and adopted assumptions, including reversibility. Lead the defaults block with the routing call:

> I treated this as open-ended and chose defaults. If you had a specific outcome in mind, say so and I will switch to asking.

Write the same defaults prominently in `## TL;DR (For humans)` under **Decisions I made for you**, but fill that TL;DR only after the detailed plan is complete. This gives the user a direct veto before final `plan_approve` clearance.

The durable `local://DRAFT.md` — Components ledger, Open Assumptions ledger, scope, test strategy, and `status: awaiting-approval` — is the compaction-safe resume point. The pre-plan okay authorizes writing the plan only. The later `plan_approve` choice authorizes handoff only. Neither authorizes Fu Xi to implement.

After pre-plan approval, follow the parent `-plan` skill ceremony and `full-workflow.md`: fresh Di Renjie, one skeleton write, todo append batches, human-first TL;DR filled last, readback, self-review, automatic dual review when required, then `plan_approve`.

Every plan targets 5–8 worker-sized todos per implementation wave where full scope supports it. Every todo includes References, Acceptance, happy/failure QA with evidence paths, `Commit:`, and `Recommended Max Turns:`. Final execution requires F1 Taishang plan compliance, F2 orchestrator-owned code-quality gate, F3 Yunu/Jin Tong real manual QA, F4 Di Renjie scope fidelity; all must APPROVE, then the user must explicitly okay completion.

## Worked example

Request: “Make auth better.”

1. Research current auth behavior, known weaknesses, repository conventions, tests, and primary best-practice sources.
2. Announce topology based on evidence — for example session hardening, brute-force protection, and password handling when the repository supports them. Keep MFA Scope OUT only if it is an adjacent capability unsupported by the request or evidence; never defer an evidence-backed requested component.
3. Record adopted defaults with rationale and reversibility, such as login rate limits, session-id rotation, or password-hash parameters grounded in the actual stack.
4. Present the derived full-scope brief and wait for explicit okay to write the plan.
5. After approval → Di Renjie contrarian review → complete plan with 5–8 todos per viable wave and TL;DR filled last → automatic dual Yan Luo + Taishang review until both OKAY → post-high-accuracy `plan_approve`.