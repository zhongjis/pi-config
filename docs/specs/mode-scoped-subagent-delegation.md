# Mode-Scoped Subagent Delegation

## Problem Statement

Mode frontmatter already declares which subagent types a mode may delegate to. Its canonical parser persists a versioned policy snapshot in `agent-mode` state; subagent direct `Agent` and RPC execution consume that snapshot. Registered Pi tool schemas cannot refresh safely after a mode switch, so the global `Agent` contract must not embed a target list that can become stale or advertise targets forbidden by an active mode.

This mismatch creates two risks. Equivalent delegation requests can produce different authorization results depending on ingress, and stale global tool guidance can advertise calls that authoritative runtime checks reject. Mode-scoped delegation needs one interpretation of mode policy, non-stale generic tool guidance, mode-prompt routing guidance, and fail-closed enforcement before every spawn or resume.

## Solution

Introduce one shared, pure delegation-policy resolver. Given session entries and available agent types, it validates the latest versioned `agent-mode` snapshot and returns permitted targets plus a structured decision for a requested target. Mode frontmatter keeps one syntax and precedence model; runtime ingresses do not reload it.

Use the resolver in two layers:

- **Affordance:** keep the registered `Agent` description generic and non-stale; it advertises no global target list. Mode prompts supply routing guidance, while denial responses report the current permitted targets.
- **Authority:** check the resolved policy at every spawn-capable ingress: direct `Agent` execution, checked RPC requests, and the global manager bridge. No request may reach manager spawn/resume until the authoritative check passes.

Modes do not authorize `Agent` calls in `tool_call`. Subagent direct, checked RPC, and global manager-bridge spawn paths are sole authorities: they consume the latest persisted snapshot and validate before spawn or resume. Direct `Agent` denial returns structured tool details; RPC retains its frozen `{ success: false, error: string }` envelope with `delegation_policy_denied:` as the stable machine-detectable prefix. Sessions with no active agent mode preserve existing unrestricted delegation; an identified active mode with unavailable config or no explicit delegation fields fails closed.

## User Stories

1. As a mode author, I want `allow_delegation_to` to define the mode's permitted subagent types, so that delegation matches the mode's responsibilities.
2. As a mode author, I want `disallow_delegation_to` applied as exclusions from the allowlist, so that broad policy can retain explicit exceptions.
3. As a mode author, I want existing frontmatter syntax and parsing preserved, so that this change does not create a second configuration format.
4. As a mode author, I want unknown agent names handled deterministically, so that stale configuration cannot silently widen access.
5. As a parent agent, I want the registered `Agent` contract to avoid advertising globally enabled targets that my active mode may forbid, so that static schema guidance never contradicts runtime policy.
6. As a parent agent, I want mode prompts to supply specialist routing and policy denials to report current permitted targets, so that I can choose or recover without stale schema data.
7. As a parent agent, I want a denied direct delegation to return a concise reason and permitted targets, so that I can recover without guessing.
8. As a parent agent, I want direct foreground and background delegation to use identical authorization, so that run mode cannot bypass policy.
9. As a parent agent, I want resumed delegation checked consistently with the target agent type and current mode, so that resume is not an alternate spawn authority.
10. As a task orchestrator, I want task tracking and delegation to remain separate, so task automation cannot bypass direct `Agent` permissions.
11. As an RPC caller, I want spawn requests rejected before manager execution when the target is forbidden, so that lower-level access does not bypass mode rules.
12. As an RPC caller, I want denial errors to retain a stable machine-detectable prefix within the standard error-only envelope, so integrations preserve protocol compatibility without parsing arbitrary prose.
13. As a user, I want equivalent direct and RPC delegation requests to have the same outcome, so behavior is predictable.
14. As a user, I want forbidden delegation to produce no child session or lifecycle side effects, so that denial is complete.
15. As a user, I want allowed delegation to preserve current prompts, lifecycle events, foreground/background behavior, and results, so that policy enforcement does not alter normal execution.
16. As a maintainer, I want one pure resolver to own allowlist/blocklist precedence, so that ingress checks cannot drift.
17. As a maintainer, I want the static `Agent` contract non-stale and denial guidance derived from the resolver, so that advertised guidance never contradicts executable policy.
18. As a maintainer, I want no duplicate modes-hook authorization branch, so direct, RPC, and global bridge execution share subagent authority.
19. As a maintainer, I want direct `Agent` execution to recheck policy authoritatively, so that hook omission or alternate invocation cannot bypass enforcement.
20. As a maintainer, I want RPC and global manager-bridge spawn handling to recheck policy authoritatively, so alternate manager access is not an authorization shortcut.
21. As a maintainer, I want checked RPC transport covered for allowed and denied targets, so future transport changes cannot reopen the bypass.
22. As a maintainer, I want policy resolution independent of spawning and UI state, so that precedence and edge cases are cheap to unit test.
23. As a maintainer, I want sessions with no active agent mode to preserve current unrestricted delegation, while an identified mode with missing or invalid policy fails closed, so that compatibility is preserved without widening access after configuration failure.
24. As a maintainer, I want denied requests to expose a stable error category without starting an agent, so that policy failures are diagnosable without false lifecycle records.
25. As an extension consumer, I want existing successful RPC result contracts preserved, so this change remains backward-compatible for allowed requests.
26. As an extension consumer, I want denied requests use one stable error category across ingresses, so that callers can handle policy failures uniformly.
27. As a test author, I want registered `Agent` tool tests to invoke real execution seams, so that policy authority is verified without claiming unsupported dynamic schema refresh.
28. As a test author, I want checked RPC and global manager-bridge tests to assert allowed and denied targets, so alternate spawn transports cannot reopen the bypass.
29. As a test author, I want unit tests limited to pure resolver behavior, so that tests avoid coupling to helper call order or private manager structure.
30. As a reviewer, I want explicit non-goals, so that this work remains a scoped authorization fix rather than an orchestration redesign.

## Implementation Decisions

- The canonical mode parser persists a versioned delegation-policy snapshot in each `agent-mode` entry. Subagent resolves the latest snapshot with the available agent registry; no ingress reparses mode frontmatter or consults modes runtime state.
- Existing shared frontmatter parsing remains authoritative for `allow_delegation_to` and `disallow_delegation_to`; its normalized snapshot is consumed by existing delegation-policy helpers rather than reimplemented at each ingress.
- Allowlist/blocklist precedence remains the current contract: the allowlist establishes candidates; the blocklist removes candidates when both are present. Unknown or unavailable targets are never added to the permitted set.
- The resolver distinguishes no active agent mode from an identified mode whose persisted policy is missing, invalid, or contains neither `allow_delegation_to` nor `disallow_delegation_to`. No active mode preserves existing unrestricted delegation; an unresolved identified mode fails closed.
- Registered Pi tool schemas cannot refresh safely after mode switches. The `Agent` description and `subagent_type` schema therefore stay generic and advertise no target list. Mode prompts provide routing; current permitted targets appear in policy denial output.
- Modes `tool_call` hooks retain non-`Agent` mode guards only; they do not duplicate delegation authorization.
- Direct `Agent` execution performs an authoritative snapshot check immediately before any new spawn or resume manager operation. Foreground and background calls share this check; denial remains a structured tool observation.
- RPC spawn and the global `Symbol.for("pi-subagents:manager")` spawn bridge perform the same authoritative check before calling the manager.
- Resume requests must not become a policy bypass. Authorization resolves the resumed record's agent type and applies current active-mode policy before manager continuation.
- Direct `Agent` denial returns structured details with `category`, `activeMode`, `requestedType`, and `permittedTypes`. RPC denial preserves the frozen error-only envelope and starts `error` with `delegation_policy_denied:`. Denial creates no child session, background record, spawn lifecycle event, or manager spawn/resume call.
- Allowed requests retain existing spawn, prompt, supervision, lifecycle, result, and restoration behavior.
- Policy context passed to RPC must come from authoritative runtime session state, not caller-supplied mode text that can be forged. Absence of an active mode preserves current unrestricted behavior; an unresolved identified mode is denied.
- No new public event or RPC envelope field is introduced. RPC denial remains `{ success: false, error: string }`; stable policy classification is the `delegation_policy_denied:` prefix.

## Testing Decisions

- Good tests assert external behavior: generic non-stale tool guidance, allow/deny outcomes, stable denial category, current permitted targets, and absence or presence of manager effects. They do not assert private helper call order or map layout.
- Registered-tool coverage invokes direct `Agent` execution and confirms forbidden spawn and resume requests return structured observations before manager side effects.
- Foreground and background `Agent` invocations use the same persisted-snapshot resolver.
- Checked RPC and global manager-bridge coverage confirm an allowed target reaches manager spawn unchanged and a forbidden target does not reach manager spawn. RPC tests also lock the standard error-only envelope and stable denial prefix.
- Denied ingress assertions include no manager spawn/resume call and no widget activation or manager-visible run caused by the denied request.
- Unit tests cover pure resolver behavior: allowlist-only, allowlist plus exclusions, empty permitted set, unknown targets, no active mode, unavailable identified mode, active mode with no delegation fields, and deterministic permitted-target ordering.
- Modes-hook tests retain prompt and non-`Agent` mode-guard coverage; delegation authorization tests belong to subagent direct/RPC seams.
- No test requires registered schema mutation after a mode switch; static `Agent` guidance must remain generic and target-free.
- Verification runs focused modes and subagent ingress tests, repo extension tests, and `pnpm lint:typecheck`.

## Out of Scope

- Redesigning mode frontmatter or adding new delegation-policy fields.
- Changing which agent types each existing mode permits.
- Reworking agent prompts, model selection, prompt modes, or nesting policy.
- Redesigning task DAGs, task ownership, batching, or specialist routing.
- Replacing the subagent manager or changing spawn lifecycle semantics.
- Changing session restoration beyond applying the same authorization to resumed agent types.
- Adding per-user, per-project, capability-based, or dynamic risk policies.
- Treating tool-description filtering as sufficient authorization.
- Broad RPC authentication or event-contract redesign.
- UI work beyond accurate registered-tool affordance and existing error presentation.
- Publishing the spec to an external issue tracker.

## Further Notes

The design follows existing seams rather than adding parallel policy layers: canonical mode parsing persists the versioned policy snapshot; delegation-policy helpers resolve it in subagent; mode prompts provide routing; static `Agent` schema stays generic; direct `Agent` execution and RPC spawn handling provide authoritative enforcement. Modes `tool_call` hooks retain unrelated mode guards, not delegation authorization.

Review should reject any implementation where modes re-authorizes `Agent`, an ingress computes policy independently, accepts caller-forged mode context, or can reach manager spawn/resume before snapshot authorization. The target invariant is simple: the same persisted mode snapshot plus the same agent type produces the same decision through direct `Agent` and checked RPC delegation.
