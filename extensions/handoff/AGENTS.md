## Purpose

Transfer focused context or an approved plan into a new session.

## Ownership

- Owns summary generation, handoff documents, session creation, and the direct handoff bridge.
- Modes owns mode selection/approval; tasks owns planning-task cleanup mutations.

## Local Contracts

- Session transfer and file export MUST retain their separate output paths.
- File summaries MUST be self-contained task briefs scoped to the goal, or current unfinished task when omitted.
- File briefs MUST use Task, Findings and evidence, Remaining questions, Constraints, and Relevant files sections.
- File briefs MUST preserve evidence, authorization limits, and secret redaction.
- File export MUST remain target-agnostic: the receiver uses its own cwd; source paths are evidence, never directory-change instructions.
- Explicit no-summary requests MUST bypass summarization.
- Approved-plan execution MUST retain the start-work handoff path.
- The direct bridge MUST unsubscribe on session shutdown.
- Bridge requests/replies MUST preserve the parent RPC envelope contract.

## Work Guidance

- [README](README.md) owns command grammar and summary-model configuration.
- Shared callers SHOULD reuse [runtime utilities](runtime.ts), not duplicate transfer logic.
- Handoff files remain temporary artifacts, distinct from task persistence.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/handoff/test`.
- [Protocol](test/protocol.test.ts) and [storage](test/storage.test.ts) cover bridge and artifact boundaries.

## Child DOX Index

- None; this document owns the entire subtree.
