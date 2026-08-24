---
name: ulw-plan
metadata:
  short-description: Conditional dual-review lifecycle for ulw-plan
---

# ulw-plan - review lifecycle

Load only when `review_required` is actionable: a complete `local://PLAN.md` exists and dual review must start or resume. This file is canonical for review state, digest/CAS, isolated reviewer intake, retries, receipts, and final live-plan validation.

One round contains exactly one fresh `yanluo` and one fresh independent `taishang`. Dispatch both against the same complete plan bytes. Both must return unconditional approval. Any fix creates a changed plan, invalidates both lanes, and requires a fresh round with both reviewers.

## Persisted request state

The draft scaffold records a known review obligation before plan creation. If review becomes required later, atomically replace stale action/review fields with this request state. Do not launch until the plan is complete.

<!-- ulw-plan-review-request-state-contract -->
```json
{
  "transition": "replace",
  "phase": "review_requested",
  "applies_when": ["explicit_review_modifier_before_complete_plan", "intent=unclear_and_nontrivial"],
  "atomic": true,
  "review_required": true,
  "plan_path": "local://PLAN.md",
  "plan_sha256": null,
  "review_round_id": null,
  "pending_action_policy": { "review_required": "write and review local://PLAN.md", "otherwise": "write local://PLAN.md" },
  "pending-action": "write and review local://PLAN.md",
  "review": {
    "yanluo": { "status": "pending", "backing_path": "local://PLAN.md", "content_delivery": null, "target": "local://PLAN.md", "round_id": null, "plan_sha256": null, "launch_id": null, "session": null, "result": null },
    "taishang": { "status": "pending", "backing_path": "local://PLAN.md", "content_delivery": null, "target": "local://PLAN.md", "round_id": null, "plan_sha256": null, "launch_id": null, "session": null, "result": null }
  }
}
```

## Initialize a round

Read complete live plan bytes from `local://PLAN.md`. Compute SHA-256 from those exact bytes. Atomically replace request state with a fresh round before launching either reviewer. `plan_path`, `backing_path`, and `target` must all equal `local://PLAN.md`; `content_delivery` must equal `inline-complete-plan-content`.

<!-- ulw-plan-review-round-state-contract -->
```json
{
  "transition": "replace",
  "phase": "review_round_initialized",
  "applies_when": ["complete_plan_after_review_request", "explicit_review_modifier_with_complete_plan", "retry_after_plan_change"],
  "atomic": true,
  "review_required": true,
  "plan_path": "local://PLAN.md",
  "plan_sha256": "<sha256-of-complete-plan>",
  "review_round_id": "<fresh-unique-round-id>",
  "round_status": "active",
  "completion_cas": ["status=in_flight", "backing_path", "content_delivery", "target", "launch_id", "round_id", "plan_sha256", "session", "receipt_identity=session", "live_plan_sha256=plan_sha256", "echoed_binding", "terminal_transition=in_flight->approved|changes_requested|inconclusive"],
  "pending-action": "review local://PLAN.md",
  "review": {
    "yanluo": { "status": "pending", "backing_path": "local://PLAN.md", "content_delivery": "inline-complete-plan-content", "target": "local://PLAN.md", "round_id": "<review-round-id>", "plan_sha256": "<plan-sha256>", "launch_id": null, "session": null, "result": null },
    "taishang": { "status": "pending", "backing_path": "local://PLAN.md", "content_delivery": "inline-complete-plan-content", "target": "local://PLAN.md", "round_id": "<review-round-id>", "plan_sha256": "<plan-sha256>", "launch_id": null, "session": null, "result": null }
  }
}
```

## Lifecycle CAS

<!-- ulw-plan-review-lifecycle-state-contract -->
```json
{
  "transitions": {
    "launch": { "from": "pending", "to": "launching", "cas": ["round_status=active", "status=pending", "backing_path", "content_delivery", "target", "round_id", "plan_sha256"], "writes": ["launch_id=<fresh-launch-id>"] },
    "receipt": { "from": "launching", "to": "in_flight", "cas": ["round_status=active", "status=launching", "backing_path", "content_delivery", "target", "round_id", "plan_sha256", "launch_id"], "writes": ["session=<agent-session-receipt>"] },
    "complete": {
      "from": "in_flight",
      "to": ["approved", "changes_requested", "inconclusive"],
      "one_shot": true,
      "cas": ["round_status=active", "backing_path", "content_delivery", "target", "launch_id", "round_id", "plan_sha256", "session", "receipt_identity=session", "live_plan_sha256=plan_sha256", "echoed_binding"]
    },
    "launch_interrupted": {
      "from": { "round_status": "active", "lane_status": "launching" },
      "to": { "round_status": "inconclusive", "lane_status": "inconclusive", "result": "launch_interrupted_without_receipt" },
      "cas": ["round_status=active", "status=launching", "backing_path", "content_delivery", "target", "round_id", "plan_sha256", "launch_id"],
      "invalidates_other_lane": true,
      "next": "fresh_review_round"
    }
  },
  "resume_after_compaction": {
    "pending": "dispatch_with_launch_cas",
    "launching": "apply_launch_interrupted_transition",
    "in_flight": "wait_for_matching_completion_only",
    "approved|changes_requested|inconclusive": "do_not_mutate",
    "round_status=inconclusive": "start_fresh_review_round"
  },
  "rejected_completions": ["duplicate", "late", "stale", "mismatched"]
}
```

Apply transitions exactly. Every launch, receipt, interruption, and completion CAS compares persisted path, delivery mode, target, round, digest, launch, and session bindings. A replaced round can never be claimed or terminalized by delayed work. Reject duplicate, late, stale, and mismatched completions.

Launch interruption without a session receipt marks lane and round inconclusive, invalidates the other lane, and requires a fresh round. Any plan-byte change also invalidates both lanes and requires a fresh digest/round. Never reconstruct state from chat history.

After compaction, read persisted state. Dispatch only `pending`; terminalize stranded `launching`; wait only for matching `in_flight`; never mutate terminal lanes. `round_status=inconclusive` starts a fresh round.

## Isolated reviewer intake

Isolated reviewers cannot access `local://`. Parent reads complete literal plan content, hashes those exact bytes, then embeds complete content plus all literal bindings in each prompt. Never pass symbolic field names, summaries, draft references, or alternate paths. Missing or drifting content/binding returns `INCONCLUSIVE` before review.

<!-- ulw-plan-review-intake-contract -->
```json
{
  "independent_reviewer": "taishang",
  "lanes": ["yanluo", "taishang"],
  "binding": "substitute_literals_before_dispatch",
  "backing_path": "local://PLAN.md",
  "content_delivery": "inline-complete-plan-content",
  "target": "local://PLAN.md",
  "first_action": "validate_complete_literal_plan_content_and_digest",
  "read_mechanism": "parent_reads_local_plan_then_embeds_complete_literal_content_and_sha256",
  "artifact_identity": "<literal-plan-sha256>",
  "round_identity": "<literal-review-round-id>",
  "launch_identity": "<literal-launch-id>",
  "required_echo": ["backing_path", "content_delivery", "target", "artifact_identity", "round_identity", "launch_identity"],
  "required_receipt": ["agent_session_identity"],
  "pre_read_validation": ["backing_path_equals_local_plan", "inline_content_is_complete", "content_digest_matches", "round_and_launch_identity_match"],
  "drift_verdict": "INCONCLUSIVE",
  "drift_conditions": ["read_failure", "path_mismatch", "unsafe_path", "backing_path_mismatch", "digest_mismatch", "content_delivery_mismatch", "launch_identity_mismatch", "receipt_identity_mismatch", "stale_or_different_artifact", "incomplete_retrieval"],
  "forbidden_fallbacks": ["search", "memory", "summaries", "alternate_files"]
}
```

Reviewer hashes inline content before review, validates literal path/content/digest/round/launch bindings, echoes them, and returns its agent session identity. Parent separately matches completion envelope to persisted session receipt.

## Launch, wait, retry

For each lane, persist `launching` and fresh launch ID through launch CAS, then call supported Agent syntax with complete literal PLAN content and bindings:

```
Agent(subagent_type="yanluo", description="Review the complete plan", prompt="TASK: ... COMPLETE LITERAL PLAN: ...", run_in_background=true, inherit_context=false)
Agent(subagent_type="taishang", description="Independently review the complete plan", prompt="TASK: ... COMPLETE LITERAL PLAN: ...", run_in_background=true, inherit_context=false)
```

Persist returned session receipt through receipt CAS. Keep both in flight. Collect each known lane only with:

```
get_subagent_result({ agent_id, wait: true })
```

Elapsed time never implies failure or cancellation. Never duplicate, replace, or terminalize a running lane because time passed. Use `steer_subagent` only for focused live correction and `Agent(resume: agentId)` only for a salvageable interrupted lane.

Complete each lane once through completion CAS. If either requests changes or is inconclusive, fix every cited issue, reread complete live plan, compute new digest, invalidate both prior receipts, and dispatch one fresh `yanluo` plus one fresh independent `taishang`. Repeat until both return unconditional approval against the same current digest.

## Receipts and final validation

Draft records both reviewer session receipts/results, round and launch identities, plan digest, and fix/retry summary. Never claim review complete unless:

- both receipts exist and match persisted sessions;
- both verdicts are unconditional approval;
- both echoed bindings match path, delivery mode, target, digest, round, and launch;
- immediately before handoff, reread complete live `local://PLAN.md`, hash exact bytes, and match approved round digest.

Any final live-plan drift invalidates both approvals and starts a fresh round. Only current-digest receipts satisfy pre-handoff completion.
