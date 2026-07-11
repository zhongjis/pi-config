# Subagent Session Restoration

**Status:** planned

## Problem Statement

Panda Harness persists each subagent conversation as a Pi session JSONL file, but the `Agent` tool can resume only while the corresponding `AgentSession` remains in memory. Completed agent records are cleaned up after a retention period or during session lifecycle cleanup. The parent conversation may still contain the valid agent ID and the tool result may still advertise that ID as resumable, yet a later resume returns `Agent not found` even though the child session file remains on disk.

This breaks an expected orchestration flow: a parent agent asks a specialist to review work, applies changes, then asks the same specialist to recheck them. The parent should recover the specialist's persisted conversation instead of losing continuity because an in-memory cache expired.

The runtime also needs a clear boundary between continuing prior work and starting independent work. It must not silently replace an unrestorable session with a fresh agent because that would discard context while presenting false continuity. A fresh session remains an explicit caller decision.

## Solution

When the caller requests `Agent(resume: agentId)`, the subagent runtime will resolve the agent in this order:

1. If the live `AgentSession` still exists, continue it directly.
2. Otherwise, use durable parent-to-child metadata to locate the persisted child session JSONL, validate the restoration environment, recreate compatible runtime dependencies, open the session through Pi's session API, and continue from its active leaf.
3. If restoration fails, return a typed failure with a stable reason. Do not start a replacement automatically.

Starting a fresh subagent remains the existing explicit path: call `Agent` without `resume`. The parent model chooses between reuse and a new session based on work semantics:

- Reuse for the same workstream, follow-up, correction, recheck, or continuation where prior findings and evidence matter.
- Start new for independent review, unrelated work, a different specialty, or any task where prior context would bias the result.
- Never reuse solely because the requested agent type matches a previous agent.

The parent and UI receive a concise status that distinguishes `resumed_live`, `restored_session`, `started_new`, and `failed`. The restored subagent does not receive a lifecycle message when restoration recreates an equivalent runtime; its persisted conversation already supplies the relevant context. If runtime compatibility cannot be established, restoration fails rather than continuing under changed assumptions.

## User Stories

1. As a parent agent, I want to resume a recently completed specialist from memory, so that a quick follow-up has no restoration overhead.
2. As a parent agent, I want to restore a cleaned-up specialist from its persisted Pi session, so that cleanup does not destroy conversational continuity.
3. As a parent agent, I want the same agent ID to identify the same logical child conversation before and after restoration, so that orchestration references remain stable.
4. As a parent agent, I want a restored specialist to retain its prior prompts, responses, tool calls, results, compactions, and active branch, so that it can evaluate follow-up work with full context.
5. As a parent agent, I want to know whether continuation used a live or restored session, so that lifecycle behavior is observable without reading raw logs.
6. As a parent agent, I want restoration failure to return a stable reason, so that I can choose an informed next action.
7. As a parent agent, I want unknown agent IDs distinguished from known agents whose session files are missing, so that typos are not mistaken for recoverable cleanup.
8. As a parent agent, I want restoration scoped to the same parent session, so that one conversation cannot resume another conversation's child agent by ID.
9. As a parent agent, I want explicit fresh-agent creation when continuity is unnecessary or undesirable, so that independent reviews remain independent.
10. As a parent agent, I want the harness never to launch a fresh replacement implicitly after restore failure, so that context loss and repeated side effects are not hidden.
11. As a specialist, I want restored conversation context to match the session I previously used, so that I do not need a synthetic explanation of my own lifecycle.
12. As a specialist, I want restoration to preserve the active branch and compaction state, so that Pi reconstructs the same model context rather than replaying unrelated branches.
13. As a specialist, I want compatible tools, model selection, thinking level, system instructions, cwd, and resource loading restored, so that the meaning of prior work remains stable.
14. As a user, I want a recheck request to continue the prior reviewer automatically when the parent explicitly supplies its agent ID, so that normal review loops do not fail after idle time.
15. As a user, I want an independent second opinion to create a new session, so that the second reviewer is not anchored by the first review.
16. As a user, I want a clear error when a child session cannot be restored, so that the system does not claim continuity it cannot provide.
17. As a user, I want persisted session files to remain the source of conversational continuity, so that live-session retention can stay bounded without degrading workflow.
18. As a maintainer, I want live cleanup to continue disposing inactive `AgentSession` objects, so that memory and runtime resources remain bounded.
19. As a maintainer, I want cleanup to retain lightweight durable lookup metadata, so that disposal does not erase the path to a persisted child session.
20. As a maintainer, I want parent-to-child linkage and child session file references persisted before a resumable result is advertised, so that every advertised resume target has a durable lookup path.
21. As a maintainer, I want restoration to use Pi's `SessionManager.open` and normal agent-session construction, so that session parsing and context reconstruction follow Pi semantics.
22. As a maintainer, I want runtime dependencies recreated from current authoritative configuration and validated against persisted metadata, so that non-serializable tools and providers are not assumed to survive cleanup.
23. As a maintainer, I want restoration failures categorized as unknown target, missing file, corrupt file, incompatible runtime, unavailable model, unavailable cwd, or scope mismatch, so that tests and UI do not parse prose errors.
24. As a maintainer, I want one lifecycle source of truth to publish live resume, restored resume, and failure transitions, so that records, events, notifications, and tool output agree.
25. As a maintainer, I want foreground and background agents to share restoration semantics, so that run mode does not change continuity guarantees.
26. As a maintainer, I want restored agents to retain existing notification and result-consumption behavior, so that restoration does not re-emit old completion messages.
27. As a maintainer, I want restoration to avoid replaying completed tool calls, so that continuing a completed session does not duplicate side effects.
28. As a maintainer, I want interrupted or incomplete prior operations detected conservatively, so that the runtime does not automatically retry uncertain tool execution.
29. As a maintainer, I want restoration attempts and outcomes traced with agent ID, parent session ID, session reference, status, reason, and latency, so that failures can be diagnosed without hidden reasoning.
30. As a maintainer, I want session paths and errors redacted or bounded in model-visible output, so that observability does not leak unnecessary filesystem details.
31. As a maintainer, I want cleanup, parent-session switch, process restart, and compaction covered by restoration tests, so that all known lifecycle boundaries preserve resumability.
32. As a maintainer, I want a deleted child session to fail restoration rather than silently create a new conversation, so that explicit deletion remains meaningful.
33. As a maintainer, I want corrupt or unsupported session files quarantined or reported without crashing the parent runtime, so that one bad child does not break orchestration.
34. As a maintainer, I want restoration to reject mismatched agent type or parent scope metadata, so that stale IDs cannot attach to the wrong runtime configuration.
35. As a maintainer, I want existing callers that omit `resume` to retain current fresh-spawn behavior, so that this feature does not change ordinary delegation.
36. As a maintainer, I want existing successful live resumes to remain behaviorally unchanged, so that restoration adds a fallback path rather than replacing the fast path.
37. As a UI consumer, I want `resumed_live` and `restored_session` displayed as successful continuation states, so that expected cleanup recovery does not look like an agent failure.
38. As a UI consumer, I want restoration failures to remain visible and inspectable, so that the interface does not conceal lost continuity.
39. As an extension consumer, I want existing public lifecycle events preserved unless a separately approved contract migration is required, so that tasks and other integrations remain compatible.
40. As an extension consumer, I want any new restoration fields added through a versioned, backward-compatible contract, so that older listeners can ignore them safely.

## Implementation Decisions

- The persisted Pi session JSONL is the durable source for child conversation history. No separate checkpoint or generated-summary fallback is part of this feature.
- The in-memory `AgentSession` remains the fast path. Existing live resume behavior stays unchanged.
- Durable lookup metadata will map the stable agent ID to its parent session, child session file, agent type, cwd, creation configuration, terminal state, and compatibility identifiers needed to rebuild runtime dependencies.
- Lookup metadata must survive child-record cleanup, parent compaction, and process restart. It must remain scoped to the parent session.
- A resumable result must not be advertised until the child session file and durable lookup metadata are available.
- Restoration will open the existing session through Pi's session-management API, rebuild the same subagent resource-loader policy, bind extensions, restore the active tool policy, and then send the new prompt.
- Concrete tools, model objects, credentials, extension handlers, and resource loaders are runtime dependencies; they are recreated, not serialized in the child JSONL.
- Restoration validates that required runtime dependencies are compatible. Missing or incompatible dependencies produce a typed failure rather than a degraded continuation.
- Successful restoration continues the existing child session and stable agent ID. It does not create a new logical agent identity.
- The lifecycle status returned to the parent uses four user-relevant outcomes: `resumed_live`, `restored_session`, `started_new`, and `failed`.
- A resume request may return `resumed_live`, `restored_session`, or `failed`. It never returns `started_new`.
- `started_new` applies only to an `Agent` invocation without `resume`.
- Restore failure reasons use stable machine-readable codes. Initial reasons cover unknown target, scope mismatch, missing session file, corrupt or unsupported session, unavailable cwd, unavailable agent configuration, unavailable model, incompatible tools/extensions, and interrupted unsafe operation.
- Model-visible errors include a concise explanation and valid next actions. Detailed paths and internal diagnostics remain in traces or expandable details.
- The restored child receives no synthetic “you were restored” prompt when runtime compatibility is exact. The parent and UI receive restoration metadata.
- If exact compatibility cannot be established, the runtime fails restoration. This specification does not define partial-continuity or checkpoint behavior.
- The parent model decides reuse versus new work from task semantics. Prompts and tool documentation will state: reuse for the same workstream; start new for independent or unrelated work; never reuse based only on agent type.
- Completed sessions are safe to continue because prior completed tool calls remain historical messages and are not replayed. Recovery of a session that ended during an unfinished provider request or tool call remains conservative and must not retry uncertain work automatically.
- Existing agent-run lifecycle projection remains the single source of truth for status changes. Restoration adds explicit lifecycle transitions rather than writing record fields independently.
- Existing completion notification, consumption, supervision, and event-bus behavior remains unchanged except where needed to represent restoration status.
- Public event or RPC payload changes require backward-compatible versioning and the repository's existing approval process.
- Live-session cleanup remains bounded. This feature preserves durable identity and lookup state rather than retaining every live session indefinitely.
- Explicit session deletion makes the child unrestorable. The runtime reports failure and does not recreate it.

## Testing Decisions

- Tests assert external behavior: whether the same conversation continues, whether prior context is available, whether the correct status is returned, and whether unsafe fallback is prevented. They do not assert private map layout or internal helper calls.
- The primary seam is the registered `Agent` tool exercised through the real subagent runtime with a temporary persisted session directory. This is the highest seam that covers tool arguments, durable lookup, cleanup, Pi session reopening, runtime reconstruction, prompting, and returned status in one test path.
- Existing subagent integration and agent-run parity tests provide prior art for tool-level continuation and lifecycle consistency.
- Focused manager/session tests cover failure classification that is expensive to trigger through the full tool seam, including corrupt files, missing runtime dependencies, scope mismatch, and unsafe interrupted operations.
- A live-resume characterization test runs before implementation and remains green: spawn, complete, resume before cleanup, observe `resumed_live`, and confirm prior context is available.
- A restoration regression test runs red before implementation: spawn, complete, dispose the live record through the production cleanup path, resume by stable ID, observe `restored_session`, and confirm the child answers using prior-session context.
- A process-restart test reconstructs the extension from persisted parent registry entries, resumes the child, and confirms restoration without relying on the original in-memory manager.
- A parent-compaction test confirms durable lookup entries survive compaction and still resolve the child session.
- A parent-session-switch test confirms cross-session child IDs cannot be restored from the wrong parent scope.
- A missing-file test confirms a known child with a deleted JSONL returns `failed` with `session_file_missing` and launches no replacement.
- An unknown-ID test confirms `target_unknown` is distinct from a known target whose file is missing.
- A corrupt-session test confirms restoration fails cleanly, does not crash the parent, and does not launch a replacement.
- A compatibility test changes required agent configuration, model availability, tool policy, extension set, or cwd and confirms restoration either rebuilds an equivalent runtime or returns the corresponding typed incompatibility.
- An interrupted-tool test confirms uncertain prior side effects are not replayed automatically.
- A notification regression test confirms restoring a consumed completed agent does not re-notify the old completion and emits only the new continuation result.
- Foreground and background variants confirm shared restoration semantics and status vocabulary.
- Fresh-spawn tests confirm an invocation without `resume` still starts a new session and reports `started_new`.
- Independent-review behavior is tested at the tool-contract level: a fresh invocation cannot inherit another agent's conversation merely because the same agent type is selected.
- Verification includes the subagent unit suite, typecheck, lint, build, and repository extension smoke tests.

## Out of Scope

- Automatically starting a fresh replacement when restoration fails.
- Checkpoint, summary-only, or prior-final-result fallback continuity.
- Durable logical aliases that map one workstream name across multiple child agent IDs.
- Resuming an in-flight provider stream.
- Automatically retrying unfinished or potentially side-effecting tool calls.
- Changing the retention period for live `AgentSession` objects.
- General workflow orchestration redesign.
- Changing task ownership, task claims, or task DAG behavior.
- Independent-review policy enforcement beyond clear tool documentation and explicit fresh invocation.
- Cross-parent or cross-user child-session restoration.
- New public event or RPC contracts without separate approval.

## Further Notes

The current failure is not caused by missing conversation persistence. Child JSONL already exists. The missing capability is durable resolution from an agent ID to that session file plus reconstruction of compatible runtime dependencies after the in-memory record is disposed.

Pi provides the required session primitive through `SessionManager.open`. Panda Harness must persist the child linkage and recreate the non-serializable runtime environment. Persisted conversation history is sufficient for completed idle sessions; it is not sufficient to resume an in-flight provider stream or safely infer whether an unfinished external side effect should run again.

The design intentionally treats restore failure as failure. If callers want independent work after failure, they can make a second explicit `Agent` invocation without `resume`. This keeps continuity claims truthful and prevents accidental duplicate work.
