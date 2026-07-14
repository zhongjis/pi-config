<!-- Pi adaptation; provenance and pinned baseline are recorded in `full-workflow.md`. -->

# -plan — CLEAR intent

Read this when routing resolves to **CLEAR**: the user knows the desired outcome, and only preferences or trade-offs that evidence cannot settle remain. Also use it for the on-the-fence tie-break (ask exactly one question) or when the user explicitly requests an interview. Read sibling `full-workflow.md` before plan generation.

## Stance

The user owns the outcome. Research first, then ask only genuine forks that only the user can decide. Act as a peer resolving the plan, not an interrogator gathering a feature list.

Plan the full requested scope. Never propose or ask about an MVP, v1, phase 1, reduced subset, deferral, or partial implementation unless the user introduced it. Scope boundaries prevent adjacent additions; they do not cut requested work.

High-accuracy review is optional only when `review_required: false`. If the user already requested high accuracy, run the dual Yan Luo + independent Taishang review after plan generation instead of offering it.

## Research protocol

Explore before asking. In one turn, dispatch independent read-only research for repository patterns, conventions, tests, and impact (`chengfeng`) plus official docs or external contracts (`wenchang`) while continuing direct investigation.

Use CodeGraph for broad architecture, flow, ownership, callers, and impact. Use LSP for symbol-precise definitions, references, implementations, types, and diagnostics. Use `rg`, `fd`, and `read` for literals, paths, config, and non-indexed text.

Triage before the two filters:

- Repository, system, or documentation fact → research, verify, and cite; never ask.
- User-owned preference or trade-off → eligible for interview.
- Unclear ownership → treat it as a user-decision.

Stop when the clearance check is answerable or after two research waves add no useful facts. Do not re-explore to double-check. Treat delegated findings as claims until grounded in repository or primary evidence.

## Interview

**TOPOLOGY LOCK first.** From the full request and evidence, enumerate 1–6 top-level components that can succeed or fail independently. Confirm them in one turn and record each in `local://DRAFT.md` with id, complete outcome, status, and evidence path. Do not collapse or omit requested components because the task looks small.

Apply the **TWO FILTERS** to every candidate question, in order:

1. Could collected evidence answer it? Explore instead.
2. Could stated intent plus a defensible default answer it? Adopt and record the default; do not ask — except owner-decisions, which always survive.

**Owner-decisions** are irreversible, destructive, safety-critical, or cross-cutting choices the user will live with: public configuration, packaging/distribution, external dependencies or pinned SHAs, and data/schema shape. Default reversible internals; surface owner-decisions.

**ASK WITH WHY.** Name what was explored, why evidence did not resolve the fork, and which plan decision changes with the answer. Ask 1–3 narrow questions per turn through `ask`, each with 2–4 options and the recommended default first. A skipped question resolves to that stated default. If the user explicitly requested an interview, disable the adopt-default filter and ask every surviving fork.

Always confirm test strategy: TDD, tests-after, or none. Agent-executed happy-path and failure-path QA remains mandatory for every todo regardless of that choice.

**FOGGIEST-GAP targeting.** Each turn addresses the single unresolved fork that most unblocks the plan; rotate among equally uncertain components. End with a question or explicit next action, never a passive summary.

**CLEARANCE CHECK after each turn:** objective defined; complete scope IN/OUT explicit; approach decided; test strategy confirmed; owner-decisions resolved; no blocking ambiguity remains. Any failure identifies the next question. All pass → update the draft, present the approval brief, and stop.

## Approval and deliver

Use the durable gate in `full-workflow.md`:

1. Update `local://DRAFT.md` with `status: awaiting-approval`, pending action `write local://PLAN.md`, the full-scope approach, findings with paths, route, review flag, components, decisions, and scope.
2. Present the brief once. Include every surviving owner-decision as an explicit question with the recommended option.
3. Wait for the user’s explicit okay. Approval permits writing the plan only, never implementation.

After approval, follow the parent `-plan` skill’s ceremony: register logical stages, run fresh Di Renjie gap analysis from the complete draft, write the plan skeleton once, append todos in batches, fill the human-first TL;DR last, read back, self-review, and call `plan_approve`.

Every plan targets 5–8 worker-sized todos per implementation wave where the full scope supports it. Each todo carries References, Acceptance, happy/failure QA with evidence paths, `Commit:`, and `Recommended Max Turns:`. Preserve the F1–F4 ownership and final explicit-user-okay gate from `full-workflow.md`.

- If `review_required: true`, run fresh dual Yan Luo + independent Taishang rounds until both return OKAY, record both receipts, then call `plan_approve({ variant: "post-high-accuracy" })`.
- If `review_required: false`, call `plan_approve({})` and let the user choose approval, refinement, or High Accuracy Review.

Never choose for the user. Never begin execution.

## Worked example

Request: “Add a 5/min-per-IP rate limit to `/login`.”

1. Explore → login middleware, existing limiter utility, shared store/client, API error conventions, and focused tests.
2. Topology lock → one complete component, “login rate limiting,” without dropping persistence, response contract, tests, or QA required by the request.
3. Apply filters. Existing repository convention may settle the storage backend. A public response contract remains an owner-decision if evidence does not settle it.
4. Ask surviving forks WITH WHY, confirm test strategy, update `local://DRAFT.md`, present full-scope brief, and wait for explicit okay.
5. After approval → Di Renjie → complete plan with TL;DR filled last → optional/required dual review → `plan_approve`.