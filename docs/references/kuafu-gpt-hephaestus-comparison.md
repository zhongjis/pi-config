# Kuafu GPT and Hephaestus prompt comparison

This reference records source inspection and design rationale. The linked prompt owns mode policy; this comparison does not establish comparative model performance.

## Evidence and scope

- Local prompt: [Kuafu GPT](../../modes/kuafu/gpt.md), with [default-family behavior](../../modes/kuafu/default.md) and [family-authoring policy](../../modes/MODEL-FAMILIES.md).
- External prompt: Hephaestus GPT-6 at revision `7e2aae87527003dbd76ff12caded8d7e4740844d`. Line references below use that revision. [1]
- Hephaestus targets GPT-6 Astra on Codex; Kuafu GPT targets GPT-6.2 Sol. The comparison is a design reference, not evidence that transfers between models.
- Kuafu references name the owning `gpt.md` section, not line numbers.
- The comparison covers prompt instructions. Runtime enforcement and observed model performance are separate evidence categories.

## Conclusion

Kuafu and Hephaestus both default to parent execution, delegate side tracks, require evidence-based completion, and scope verification. Their main difference is specialist ownership: Kuafu routes UI work, consultation, and finish-gate review to required specialists before its self-execution default applies; Hephaestus has no required specialists. Neither prompt establishes that its policy performs better. [1]

[Kuafu GPT's routing](../../modes/kuafu/gpt.md#do-it-yourself-or-delegate) applies required specialist boundaries, then keeps work with the parent unless a delegated track runs beside the parent's work and lands the task sooner. Its [exploration rules](../../modes/kuafu/gpt.md#exploration-rules) assign distinct unresolved questions without a research quota. Both GPT and [default](../../modes/kuafu/default.md#delegation-policy) make tactical consultation depend on meaningful execution uncertainty; the separate complex self-execution planning and approval workflow remains authoritative.

## Clause crosswalk

Each external comparison refers to the pinned Hephaestus source. [1]

| Kuafu GPT section | Hephaestus lines | Finding |
| --- | --- | --- |
| Role; General | 6, 40 | Orchestrator versus executor emphasis; both permit direct work and delegation. [1] |
| Instruction priority | 26–28 | Shared instruction authority; Kuafu explicitly treats fetched content as data. [1] |
| Batch independent work | 32–36, 40 | Both batch read-only discovery by default, reduce results in code mode, and keep direct calls for cases where batching buys nothing. [1] |
| Step 0: Identify lookup triggers | 40 | Kuafu identifies discovery needs through its exploration policy; Hephaestus defaults ordinary lookups to the parent. [1] |
| Step 1: Interpret and announce | 10–14, 22, 54, 121 | Both bind execution to an announced outcome; Kuafu specifies more announcement fields and repository-grounded checks. [1] |
| Step 2: Check implementation authorization | 14, 20, 22 | Shared session authorization; Kuafu adds explicit worker continuation and human-stop handling. [1] |
| Step 2 readiness; Step 3: Resolve blocking ambiguity | 20, 28, 38, 40, 85 | Both ground action and place approval after authorized preparation. [1] |
| Investigate before acting | 38 | Both require source inspection and appropriate symbol tools; local tools differ. [1] |
| Skill loading | 26 | Both apply relevant skills; Kuafu explicitly limits reference reading to the active workflow. [1] |
| Scope: root cause | 38 | Both prefer root-cause investigation. [1] |
| Scope: minimal change | 18, 75 | Shared scope and minimalism; Kuafu adds external-failure triage and explicit complexity tradeoffs. [1] |
| Scope: task tracking | 42 | Both track multi-step work, uncertain scope, multiple files, or branching investigation; Hephaestus specifies a more explicit item lifecycle. [1] |
| Exploration rules: delegation | 40 | Both dispatch useful research tracks; Kuafu assigns distinct questions without a quota. [1] |
| Exploration rules: direct tools and researchers | 36, 40, 83–84 | Both support direct lookup and research specialists. [1] |
| Exploration rules: trust and stop | 38, 40 | Both prohibit duplicate discovery and stop after convergence. [1] |
| Do it yourself or delegate | 40 | Both default to self-execution, delegate side tracks that land the task sooner, and keep a child result that is the next input with the parent; Kuafu applies required specialist ownership first. [1] |
| Specialists and implementation workers: roster, research audit, worker choice | 83–87 | Kuafu adds dynamic routing, opened-source auditing, and evidence-based worker selection. [1] |
| Specialists and implementation workers: `taishang` | No direct counterpart | Kuafu defines architecture-consultation triggers and exclusions. |
| Specialists and implementation workers: `xuannv` | 85 | Both reserve tactical consultation for unresolved decisions rather than known work splits. [1] |
| Specialists and implementation workers: `deep-plan` | 85 | Kuafu has a separate complex self-execution planning and approval gate. [1] |
| Split work: packet bounds | 40, 87 | Shared bounded assignments; Kuafu adds coupled invariants, checkpoints, and resume anchors. [1] |
| Split work: recovery | 40 | Kuafu favors worker recovery; Hephaestus takes delegated follow-ups back into the parent. [1] |
| Delegation packet | 87 | Shared outcome/evidence handoff and independent test judgment; Kuafu preserves original context, user-required checks, and research ownership. [1] |
| Supervise: background agents | 46–50 | Both supervise background agents; Hephaestus extends asynchronous scheduling to long commands. [1] |
| Supervise: steering and recovery | 40, 50 | Shared steering and recovery; follow-up ownership differs. [1] |
| UI work | 69 | Shared surface QA; Kuafu adds UI ownership, fidelity boundaries, and explicit review opt-in. [1] |
| Done and verification: items 1–4 | 38, 54, 96 | Shared grounding and scoped checks; Kuafu explicitly separates worker evidence from combined-result verification. [1] |
| Done and verification: manual QA and shared state | 69, 93 | Shared surface QA and failure disclosure; Kuafu adds shared-state isolation and explicit push authorization. [1] |
| Done and verification: new tests | 56, 64 | Both add tests only where a regression would otherwise pass unnoticed and prove prose and prompt changes without new tests. [1] |
| Done and verification: finish gate | 71 | Review triggers differ; neither policy is uniformly lighter. [1] |
| Done and verification: recovery | 77 | Kuafu consults a specialist before the final recovery attempt; Hephaestus escalates after three failed approaches. [1] |
| Done and verification: stop | 18, 121–123 | Shared observable completion and stopping without handing back unfinished work; Kuafu explicitly includes corrections and cleanup. [1] |
| Working with the user | 101–105, 115, 117 | Shared outcome-first, self-contained final answers and findings-first reviews. [1] |
| Intermediary updates | 109–113 | Kuafu requests meaningful updates; Hephaestus prescribes a structured handoff block. [1] |
| Hard rules 1–7 | 6, 18, 56–65, 93–96 | Shared evidence, scope, Git, and test-integrity safeguards; local skill ownership matters. [1] |
| Hard rule 8 | 123 | Shared compaction continuity. [1] |

## Interpretation boundaries

- Direct execution is already part of Kuafu; adopting it is not a missing capability.
- Conditional exploration preserves specialist delegation rather than replacing orchestration with parent-only execution.
- Tactical consultation and the separate complex self-execution approval gate serve different decisions.
- Handoffs should preserve required outcomes and user constraints while leaving room for independent test judgment.
- Shorter worker prompts alone do not establish better results. Local recovery, refusal, truthful outcomes, and parent acceptance remain material contracts.
- Test-integrity rules may live in skills rather than the main prompt. Prompt-body absence does not establish harness absence.

## Runtime findings

- [Mode injection](../../extensions/modes/src/hooks.ts) selects the resolved model family and expands the roster. GPT replaces the default body rather than adding a second body.
- [Child tool scope](../../extensions/subagents/src/agent-tool-scope.ts) enforces permissions; [execution classification](../../extensions/subagents/src/execution.ts) is not semantic acceptance.
- [LSP integration](../../extensions/lsp/index.ts) already injects edit diagnostics and late-error feedback. Automatic diagnostics are not a missing tool.
- [Goal continuation](../../extensions/goal/src/index.ts) and [graph gates](../../extensions/subagents/src/graph/gate-handoff.ts) already provide persistent execution machinery.
- LazyCodex's worker receipt validator checks receipt-file properties, not correctness, and has bypass conditions. Its spawn admission adds conditional QA-artifact checks. These are optional runtime design references, not conclusions from main-prompt wording. [2][3]

## Model-informed assessment

### Documented behavior

OpenAI's GPT-6.2 guidance covers behavior observed on Astra and Sol. GPT-6.2 is concise by default, may propose a next step and wait when intent is unclear, should make reasonable reversible assumptions, and should skip new tests unless requested, required, or needed for a missed regression. The API drops reasoning items when instructions or tool calls change mid-conversation. [6]

The GPT-6 Astra guidance, which Hephaestus targets, notes that Astra may delegate less often than a workflow needs and recommends calibrating testing for small changes. The GPT-6.2 guidance does not restate the delegation note. [4]

OpenAI also warns that elaborate recipes and overly broad skill triggers can overconstrain Astra. Instructions that help Sol or Luna may hinder Astra; task-relevant context and precise permission boundaries matter. [5]

### Local interpretation

Kuafu uses conditional, outcome-first wording while preserving its orchestration responsibilities. This is a design choice, not evidence that Hephaestus performs better.

- **Safe autonomy:** [authorization](../../modes/kuafu/gpt.md#step-2-check-implementation-authorization) and completion remain explicit; the [stop rule](../../modes/kuafu/gpt.md#done-and-verification) forbids ending on a plan, an offer, or a routine question while an authorized next step remains.
- **Self-execution default:** [routing](../../modes/kuafu/gpt.md#do-it-yourself-or-delegate) keeps work with the parent after required specialist boundaries and delegates only side tracks that land the task sooner.
- **Decision-based planning:** [tactical consultation](../../modes/kuafu/gpt.md#specialists-and-implementation-workers) addresses unresolved execution choices; the complex self-execution planning gate retains its approvals.
- **Bounded verification:** [completion](../../modes/kuafu/gpt.md#done-and-verification) retains valid evidence reuse, combined-result acceptance, and GPT-6.2's new-test threshold.
- **Focused skills and handoffs:** [skill loading](../../modes/kuafu/gpt.md#skill-loading) follows the active workflow; [handoffs](../../modes/kuafu/gpt.md#delegation-packet) preserve independent test judgment and user-required checks.
- **Assembled context:** the selected body, project instructions, loaded skills, tool descriptions, and opt-in overlays all influence behavior. A change to one body cannot resolve a conflicting requirement elsewhere.

### GPT versus Claude and model-specific limits

The official sources do not establish that Claude needs rigid protocols, that GPT needs a particular persona, or that direct executors outperform orchestrators. [4][5][6] The [family guide](../../modes/MODEL-FAMILIES.md) labels its default-family characterization as local practice. Treat that distinction as a local hypothesis, not a vendor-backed universal rule.

### Behavior evaluation

Compare the current and revised assembled prompts on the same representative tasks: a known small fix, unfamiliar parallel work, a meaningful planning choice, a constrained UI change, a follow-up correction, a completed check reused after continuation, and a skill-imposed approval conflict. Hold model, effort, tools, and repository starting state constant. Repeat enough runs to distinguish variability from a consistent effect.

Judge correctness, scope, missing work, required delegation and approvals, unnecessary pauses, duplicate checks, elapsed time, and tokens. Evaluate the GPT models actually used by the harness separately. These scenarios and metrics are proposed local evaluation criteria, not vendor performance claims. No prompt benchmark is included in this record.

## Refresh and verification

Re-read the linked local prompt sections, pinned external source, and official model guidance before applying these findings. To compare another upstream revision, update the revision and line mapping together. Validate prompt changes on representative tasks through the assembled prompt; text similarity and prose-pinning tests do not establish behavior.

## Sources

- [1] Hephaestus GPT-6 prompt (https://github.com/code-yeongyu/lazycodex/blob/7e2aae87527003dbd76ff12caded8d7e4740844d/plugins/omo/components/rules/bundled-rules/hephaestus/gpt-6.md)
- [2] LazyCodex worker receipt validator (https://github.com/code-yeongyu/lazycodex/blob/7e2aae87527003dbd76ff12caded8d7e4740844d/plugins/omo/components/lazycodex-executor-verify/src/codex-hook.ts)
- [3] LazyCodex spawn admission guards (https://github.com/code-yeongyu/lazycodex/blob/7e2aae87527003dbd76ff12caded8d7e4740844d/plugins/omo/components/ulw-loop/src/spawn-guard.ts)
- [4] OpenAI, GPT-6 Astra: Prompting best practices (https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra#prompting-best-practices)
- [5] OpenAI, Rethinking skills and prompts for GPT-6 Astra (https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)
- [6] OpenAI, Using GPT-6.2: Prompting best practices (https://developers.openai.com/api/docs/guides/latest-model/gpt-6.2-astra#prompting-best-practices)
