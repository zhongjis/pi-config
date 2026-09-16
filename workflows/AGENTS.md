## Purpose

Personal reusable saved SubagentWorkflow sources, returning structured results rather than publications.

## Ownership

- Owns authored workflow sources in this directory; runtime and authoring API belong to `extensions/subagents/`.
- `deep-research.js` owns its bounded frontier, evidence ledger, independent review, and coverage decisions.
- `last30days.js` owns shared topic resolution, one canonical engine run, conditional evidence annotations, and independent verification.

## Local Contracts

- Execution requires explicit workflow opt-in and caller-checked live agent selectors with stage-appropriate permissions. Prompts do not enforce permissions; only `last30days` engine stage may write or run the canonical command.
- `deep-research` requires a nonblank question, 1–6 unique nonblank requirements, read-only selector, and evidence context; optional `maxRounds` is 1–3. Requirements are trimmed before semantic deduplication.
- Maximums: 3 rounds, 3 concurrent discovery calls per round, 12 admitted frontier questions, and 15 scheduled calls. Each round uses fresh skeptic and verifier calls; no script retry loop.
- Each discovery returns at most 3 evidence records, 3 claims, and 3 follow-ups. Run ledgers therefore contain at most 27 evidence/claim records, 27 proposed follow-ups, 81 challenges, and 81 rejection snapshots. Overflow/unknown-requirement follow-ups remain in `deferredQuestions`.
- Discovery merges in question order and assigns script-owned `q`, `e`, `c` IDs; challenges receive `h` IDs. Verification cites claim-owned evidence IDs and matching source locations, with independently inspected excerpts. Votes never establish support.
- Declare accepted coverage with `outcome.succeed`, rejection with `outcome.fail(stopReason, result)`; required evidence failures MUST stop dependent analysis. User skips MUST stop downstream required stages and return explicit rejection.
- Return a payload containing cited findings, contested and historical rejected claims, gaps, per-requirement coverage, evidence/claim/challenge/frontier ledgers, deferred questions, missing stages, and metrics. Coverage preserves attempted/missing/deferred question IDs and historical rejected claim IDs.
- Continue only on a new high-water mark for independently supported source count, verified requirement coverage, or resolved challenges. Metrics expose these high-water marks, not cost estimates.
- Stop reasons: `covered`, `converged`, `frontier_exhausted`, `round_limit`, `missing_required_result`, `verification_failed`. Missing required calls and invalid verification block acceptance; `covered` alone accepts, after all requirements have support and no unresolved challenge undermines them.
- No filesystem writes, rendering, publication, hard-cost guarantee, filesystem isolation, or cross-session recovery. Source installation/discovery configuration is outside this directory's execution contract.
- `last30days` requires a topic, inclusive date window, active source list, resolver/engine/specialist/verifier selectors, and absolute `skillDir`/`memoryDir` paths; it never accepts an arbitrary command.
- Its engine agent runs `${skillDir}/scripts/last30days.py` exactly once with one shared plan and the caller-supplied active source set via `--search`; it may write only plan/output artifacts under `memoryDir`, and source collection remains inside that canonical engine run.
- Its bounded targeting plan may specify broad/dedicated subreddits, X handles, GitHub targets, TikTok/Instagram targets, Trustpilot domain, Polymarket keywords, Amazon query, and Telegram sources; empty flags are omitted.
- Comparison peers are bounded, unique, required exactly for comparison intent, and serialized as one `--competitors-plan` file under `memoryDir`; the main entity uses outer targeting.
- Triage selects 0–3 unique specialist lanes. Specialists alone use optional calls; missing annotations remain gaps. Acceptance requires independently verified original evidence and an inspected raw artifact; accepted gaps declare partial outcome, rejection declares failed outcome.

## Work Guidance

- Follow `extensions/subagents/skills/subagent-workflows/SKILL.md`; metadata/input schemas must remain pure literals and agent output schemas object-root.
- Keep changes local and behavior-focused. Tests must use the real loader/executor with fixture hosts, never assert prompt prose.

## Verification

- `pnpm exec vitest run --project unit test/deep-research-workflow.test.ts`
- `pnpm lint:typecheck`
- `pnpm exec vitest run --project unit test/last30days-workflow.test.ts` verifies acceptance, optional gaps, and required-stage failure through the real runtime with fixture hosts.
- Real-agent execution requires separate authorization; fixture execution does not establish provider availability or research truth.

## Child DOX Index

- None.
