# Xiangxi GPT overengineering audit

Status: idea

## Finding and scope

The strongest finding is a parent-agenda/worker-elaboration chain, not a general tendency of every GPT agent. In one Railway simplification, the parent requested broad matrices and planner-discrepancy proof; two Jintong workers chose redundant permutations. A separate Fuxi plan prescribed repeated gates, task-specific reporting, and credential transport without additional privilege separation. These are specific excesses relative to acceptance and existing authority. A large request, a substantial implementation, or a high total test count is not inherently overengineering.

The research inspected raw visible messages, tool edits, and immutable Git changes, then checked current prompt text and inventory. Observation, attribution, and proposed prompt mechanisms are distinguished below. Originally drafted against pi-config `37dd108f65363de258cc18bf6539da6e81f72ce0`, this audit records the approved and applied P1–P3 changes below. P5–P6 are approved and applied to their shared prompts unconditionally; this idea document is not execution policy.

Discovery found 334 matching Xiangxi session files, not 334 deeply audited sessions. Deep coverage comprises S1–S3 and two direct children, C1–C2. Contextual coverage includes the September 7 A2A-68 Fuxi planning session, `2026-09-07T05-38-56-872Z_01a07a60-74e8-7a0e-ac2e-22b972e42334` (mode switch at lines 179–180; 149 GPT assistant messages), whose initial request explicitly wanted Railway IaC/design. Two recent root sessions were sampled: `2026-09-11T23-04-27-336Z_01a092b7-15c8-7205-bac3-d66302a790d5` and `2026-09-11T23-52-29-450Z_01a092e3-100a-7097-91ac-e4e4baabc4dc`; neither established overengineering. Selected primary dates are September 7–11 UTC. This is targeted case research, not random sampling or a prevalence estimate.

## Local source legend

These are local evidence references, not external vendor claims. Line numbers identify JSONL records, not rendered conversation turns. Times below are UTC on the source filename's date unless stated otherwise.

- **S1:** `/home/zshen/.pi/agent/sessions/--home-zshen-.herdr-worktrees-xiangxi-a2a-68-runtime-deploy--/2026-09-11T05-35-40-967Z_01a08ef6-e7a7-76f5-a080-82665bd53701.jsonl`. Kuafu; all 203 assistant messages used `gpt-6-astra`. Anchors: line 229, `4a72b936`, 06:37:59; line 287, `4d6bf820`, 06:47:38; line 291, `cf72f660`, 06:48:23; line 454, `cf1c7970`, 07:20:18; cleanup packet at line 473.
- **C1:** `/home/zshen/.pi/agent/subagent-sessions/01a08ef6-e7a7-76f5-a080-82665bd53701/2026-09-11T06-48-23-169Z_01a08f39-7781-76f5-a080-82c7df0bc53b.jsonl`. `jintong#cc6f153d`; 18 GPT assistant messages. Line 24, `77c1e0d9`, 06:49:27; line 33, `7f6a3174`, 06:49:54.
- **C2:** `/home/zshen/.pi/agent/subagent-sessions/01a08ef6-e7a7-76f5-a080-82665bd53701/2026-09-11T06-47-38-860Z_01a08f38-ca6c-76f5-a080-82c54a717f9a.jsonl`. `jintong#d155af88`; 21 GPT assistant messages. Line 18, `73e2c4b7`, 06:49:38; line 47, `30b2cad2`, 06:53:51.
- **S2:** `/home/zshen/.pi/agent/sessions/--home-zshen-.herdr-worktrees-xiangxi-a2a-100-durable-concurrent-stacks-support--/2026-09-08T04-08-38-277Z_01a07f34-2285-7328-b4cd-3f8949972077.jsonl`. Fuxi switch at lines 14–15; all 185 assistant messages used GPT. Anchors: line 424, `6ef250ba`, 09:18:17; historical Taishang result at 435; saved plan at 438/440; line 448, `d18c68d7`, 09:32:01; line 450, `ddebae05`, 09:32:19.
- **S3:** `/home/zshen/.pi/agent/sessions/--home-zshen-.herdr-worktrees-xiangxi-railway-deployment-finalization--/2026-09-11T23-17-04-062Z_01a092c2-a1be-7273-9ff5-4ed0aa325e6e.jsonl`. Kuafu/GPT. Line 26, `9373716f`, 23:24:21; diagnostic answer at 23:26:56; line 59, `71cf5c69`, 23:29:08.

Git evidence resides in Xiangxi's worktree `/home/zshen/.herdr/worktrees/xiangxi/a2a-68-runtime-deploy`; `/home/zshen/personal/xiangxi` is bare. Relevant immutable commits are `98a975f1061bdde15e2ff5276d6670f6d72ad5a6`, `f7ab8250800e411bd935646dcf84e6c153b7dbb9`, and `4d787513783e441d1ea368fee7cac2923961dbc7`. Later rebasing makes immutable IDs preferable to current-branch descriptions. No cloud calls or historical suites were rerun for this report.

## Confirmed cases and limits

### E1 — 96 fake-planner tests

**Observation:** C1 line 24 edits `release.test.mjs` into 16 fixture variants × two modes × three forced results = 96 cases. The mock assigns `s.plan` directly; it does not execute the native drift detector. The initial tests can show that each removed local guard no longer intercepts a fixture. However, the 16 × 2 × 3 product adds redundant cross-dimension proof and cannot establish native detector behavior.

**Attribution:** S1 line 291 explicitly asks for “add RED tests proving these planner-owned discrepancies reach plan authority.” The parent selected that proof agenda; Jintong selected the permutations. The worker did not independently invent the whole task, but translated an overbroad packet into overbroad tests.

**Hypothesis:** Strong proof language plus preserving old combinations encouraged testing a mocked replacement as though it established platform behavior. P1, P3, and P6 address that mismatch without removing caller-handling tests.

### E2 — 4,800 workflow combinations

**Observation:** C2 line 18 adds WF04 with seven loops: three events × two fork states × five changed values × four verify statuses × four infra statuses × five ready values × two cancelled states = **4,800 combinations**, with two assertions each (9,600 assertions). This is one generated inner scenario loop, not 4,800 Node tests. The child edit, cleanup commit, and executable arithmetic agree with the session's 4,800 count. C2 line 47 changes `TRUE` to `unknown` because the JavaScript VM equality model does not emulate Actions, following parent direction at S1 line 328.

**Attribution:** S1 line 287 requested “Gate matrix verify/infra statuses+ready/change values+fork+event+cancelled.” Jintong chose the Cartesian product. Native-platform misunderstanding and parent scope both matter.

At S1 line 454 the user asked why 307 Railway tests were needed. At 07:20:52 the parent admitted, “I expanded the test matrix too far while calling this a simplification.” Cleanup commit `f7ab825` changes only `release.test`, `workflows.test`, and `.railway/AGENTS.md`: 96 fake-planner cases become four; 4,800 workflow combinations become 15. Reported Railway totals move from 307 to 172. These historical counts are not fresh test results or sole proof of equivalence; the parent inspected retained boundaries. The relevant defect is redundant modeled evidence, not the number alone.

### E3 — Fuxi repeated gates and per-task reporting

**Observation:** S2 saved-plan readbacks at 438/440 require Todo 6 to “run full pnpm verify and explicitly pnpm test:dev-stack,” F2 to run `pnpm verify`, and F3 to “Run pnpm test:dev-stack from fresh source, then …” plus browser QA. The same plan wires the dev-stack suite into the ordinary web include, so the aggregate gate would already execute it. The plan also requires artifacts such as `.artifacts/a2a-100/task-1-happy.json`. Three expensive ordinary Vitest files create fixture-multiplication risk; no runtime increase was measured.

**Attribution:** This is planned overprescription, not proof that redundant runs or reporters shipped. S2 line 426 returned the historical skill's “zero judgment calls” and per-todo QA instructions. The canonical spec at 444 demands isolation, durable state, and real acceptance—not bespoke JSON or repeated execution. Following the user's rereview request, historical Taishang result 435 identified five issues. At 448 the parent recommended a single serial acceptance fixture, preserving simultaneous launches within the concurrency test, plus valid final-gate evidence and standard-log reuse. User 450 approved.

**Hypothesis:** The planner overprescribed execution mechanics when simpler, decision-complete instructions would satisfy acceptance. Zero executor judgment remains required: Fu Xi must resolve implementation decisions before handoff. P5 clarifies evidence reuse while preserving all reviews and distinct manual QA.

### E4 — Same-anchor credentials over IPC

**Observation:** S2 decision 9 says anchors receive no DB credentials, while decision 10/Todo 4 sends the assigned child's phase environment over IPC to that same anchor. Same-principal components still receive the same credentials: transport changes do not establish another privilege boundary.

**Attribution:** This was a planned credential-plumbing mistake with an accepted revision, not demonstrated shipped code. The parent recommended direct per-service allowlisted environment to the anchor while retaining ownership IPC; user 450 approved. The process-group anchor remains necessary for owned-descendant cleanup. User 370 explicitly requested stale-container cleanup, and user 284 asked about current Podman compatibility; neither requirement was invented scope.

P2 addresses this failure class in Kuafu by asking for an actual requirement or failure mode before another protocol; Fuxi does not load that prompt. Fuxi's correction belongs in the planner choosing simpler, complete instructions, not executor discretion. A resolver-versus-single-preload proposal remained feasibility-unverified, and changing manual-volume recovery required approval; neither is counted as a confirmed mistake.

### E5 — Duplicate positive IaC validators

**Observation:** C1 line 33 and commit `98a975f` remove duplicate positive command, health, and literal checks from `release-inventory`. Independent volume, domain, network, source, and resolved DB URL checks remain. The distinction is duplicated authority versus independent safety predicates, not “all validation is bad.”

**Attribution:** The same worker who elaborated E1 also pruned redundant checks. That is an important control against a personality-level explanation. P2 makes the authority distinction explicit upstream; it does not authorize deleting independent guards.

### E6 — Brittle candidate identity/time gates

**Observation:** S3 records a six-way deployment checker and a failed deploy. At 23:26:56 the agent reports `deployment-identity-mismatch` after accepted upload but cannot obtain cloud metadata. The actual failing conjunct is unknown. Commit `4d787513` removes `Date.parse(d.createdAt) >= candidate.started` and `d.meta?.message === sha`, retaining exact deployment ID, project, environment, service, real revision metadata when present, candidate SUCCESS, and public health.

**Attribution limit:** This supports concern about unsupported timestamp/message gates, not a claim that clock skew caused the observed failure or that the deployed fix succeeded. P2 targets unsupported additional predicates; the surviving identity and health conditions are conservative controls.

## Prompt inventory and causal assessment

The audit covered all ten enabled definitions: Chengfeng and Wenchang research; Taishang architecture consultation; DiRenjie scope/gap analysis; Yanluo plan review; Xuannv tactical planning; Guangguang, Jintong, Juling, and Yunu implementation. `Explore`, `Plan`, and `general-purpose` are disabled. Current filenames and disabled flags were checked while drafting. Only Jintong has sufficient direct failure evidence for an agent patch. Workers already request minimal local changes. Juling's correct concurrent-purge regression is a control; no failure was established for Yunu or Guangguang. DiRenjie/Yanluo focus on material blockers, and Xuannv assisted pruning. No blanket rewrite is justified.

All six Fuxi skill Markdown files were covered in the audit: `SKILL.md`, `references/full-workflow.md`, `intent-clear.md`, `intent-unclear.md`, `adversarial-research.md`, and `review-lifecycle.md`. They are shared across model families, with no GPT variant. The workflow clarification and Fu Xi re-audit changes are applied; the live zero-judgment invariant remains unchanged. Branching, adversarial research, approval, digest, receipts, and fresh-review mechanics remain required.

Current Kuafu restored its current-message gate in `3999181`, September 11 at 00:27 PDT, after the first S1 matrix. That restored gate cannot explain the earlier matrix. ULW `1ffd715` from September 8 already provides evidence reuse and prohibits filler scenarios: part of the observed problem is compliance, not missing rules. Runtime agent/mode paths point into this repository, but child logs lack full system snapshots. Session-local scope and mode/model metadata do not prove every historical instruction loaded.

Prompt pressure is therefore a plausible contributor, not a uniquely identified or sufficient cause. Competing explanations include native-authority misunderstanding, strict user/local specifications, incomplete delegation context, role differences, and changes between historical and current prompts. There is no matched non-GPT comparison and no basis to claim GPT-specific propensity. Two current-audit Taishang consultations, recorded under `a1d3467a-9bd0-40e`, informed the audit; consultation is not an experiment.

## Patch disposition, grouped by mechanism

P1–P3 are approved and applied; P5–P6 are applied shared, unconditional instructions. The snippets below record the applied additions. No model selection or frontmatter changes are proposed or applied.

### P1 — Preserve outcome and authority through delegation

Reason: [E1–E2](#e1--96-fake-planner-tests) show a parent proof agenda amplified by worker mechanics. Carry accepted exclusions and authority, without requiring an invented alternatives exercise.

````diff
--- a/modes/kuafu/gpt.md
+++ b/modes/kuafu/gpt.md
@@ -63,7 +63,7 @@
 - Split multi-stream work; parallelize only independent chunks.
 - Never bundle unrelated cleanup, multi-module features, and verification into one worker prompt.
 - Delegated prompts must be complete but bounded: `TASK`, `EXPECTED OUTCOME`, `REQUIRED TOOLS`, `MUST DO`, `MUST NOT DO`, `CONTEXT`. Length alone is not quality.
-- Include exact scope, files, acceptance criteria, and focused verification when known.
+- Include the accepted user outcome, relevant exclusions, existing authority to reuse, exact files, acceptance criteria, and focused verification. Preserve rejected approaches and their reasons when present; do not invent an alternatives exercise.
 - Before every delegation, evaluate every available skill, including user-installed skills, and pass the smallest non-redundant set whose instructions apply to execution or verification; `skills=[]` is valid when none apply.
 - When delegating to `yunu`, do not hardcode Impeccable reference paths. Tell Yunu to use the preloaded `impeccable` skill/router and its own `Source:` / `Skill directory:`.
 - Do not delegate overlapping discovery to multiple agents; choose the narrowest specialist.
````

### P2 — Justify additions against existing authority

Reason: [E4](#e4--same-anchor-credentials-over-ipc), E5, and E6 distinguish real safety predicates from credential plumbing and unsupported duplicate checks. P2 targets the same failure class in Kuafu, not Fuxi; Fu Xi remains responsible for selecting simpler mechanics before handoff.

````diff
--- a/modes/kuafu/gpt.md
+++ b/modes/kuafu/gpt.md
@@ -81,6 +81,7 @@
 
 <scope_discipline>
 Smallest safe change wins. Match existing patterns. No unrelated refactors, formatting churn, dependencies, speculative abstractions, provider/model/auth/config edits, or commits unless explicitly requested. Mention unrelated problems; do not fix them.
+Before adding a checker, abstraction, or protocol, identify the requested requirement or concrete failure mode it covers and why the existing implementation, native platform, or installed dependency does not suffice. Same-principal components receiving the same credentials do not create a new privilege boundary merely by changing credential transport.
 </scope_discipline>
 
 <pattern_maturity>
````

### P3 — Distinct failure modes, not automatic products

Reason: [E2](#e2--4800-workflow-combinations) demonstrates Cartesian elaboration, E1 the mock/native distinction, and E3 unnecessary reporting. TDD, full suite, manual QA, invalidation, and routing remain unchanged.

````diff
--- a/extensions/ulw/prompts/gpt.md
+++ b/extensions/ulw/prompts/gpt.md
@@ -127,6 +127,8 @@
 - The real surface and artifact that prove it.
 - The test file and test ID, or justified TDD exemption.
 
+You MUST choose representative cases for distinct failure modes. Use cross-product matrices only for concrete interaction risks not covered by those cases. A mocked platform result proves caller handling, not the platform behavior that produced it. Existing assertions, command logs, and surface artifacts MAY satisfy multiple scenario evidence paths; do not build per-scenario reporting machinery unless a required observable cannot otherwise be captured.
+
 Scenarios are the acceptance contract. You MUST capture the applicable evidence from the verification checklist for every scenario.
 
 ## TDD (MANDATORY on every production change)
````

### P5 — Own checks and reuse valid evidence (applied, shared, unconditional)

Reason: [E3](#e3--fuxi-repeated-gates-and-per-task-reporting) shows repeated acceptance commands and JSON paths not required by the spec. Keep the template, eight headers, F1–F4, and digest/receipt requirements intact.

````diff
--- a/modes/fuxi/skills/ulw-plan/references/full-workflow.md
+++ b/modes/fuxi/skills/ulw-plan/references/full-workflow.md
@@ -62,6 +62,8 @@
 Juling triggers: architecture/data-ownership/trust-boundary reasoning; security/concurrency/migration/performance invariant; ambiguous debugging after focused recon; cross-workstream integration; diagnosed standard-worker reasoning failure. Size, file count, importance, or uncertain estimate alone are not triggers.
 Failure classification: Missing context/input → enrich packet and retry same tier. Tool/runtime failure → repair and retry same tier. Unexpected coupling → replan and merge. Only diagnosed reasoning-capability failure or increased risk escalates.
 
+QA fields may reference existing assertions, logs, and surface artifacts; they do not require a new JSON reporter or separate run per todo. Assign each required check an owner and reuse its evidence across todos and F1-F4 while source, dependencies, configuration, environment, and external state remain valid. Rerun missing or invalidated checks, retain distinct manual QA, and preserve every required review. Choose representative failure cases; add combinations only for concrete interaction risks.
+
 Each implementation todo contains:
 
 ```
````

### P6 — Challenge redundant mechanics without weakening acceptance (applied, shared, unconditional)

Reason: [E1](#e1--96-fake-planner-tests) and E2 directly implicate Jintong's permutation choices. Reporting a smaller alternative preserves parent authority over mandatory checks.

````diff
--- a/agents/jintong.md
+++ b/agents/jintong.md
@@ -22,6 +22,7 @@
 MUST stay inside assigned scope. MUST NOT expand task, re-plan whole problem, delegate onward, or add unrelated improvements.
 If the assigned task is genuinely ambiguous or under-specified, stop before edits and report `BLOCKED` naming what is unclear. Otherwise execute the whole assigned task; if you cannot finish within your turn/tool budget, stop at the last green state, leave the tree unbroken, and report an exact resume anchor as `BLOCKED` — never report partial work as `COMPLETED`.
 Prefer minimal local changes that match existing code patterns.
+Choose the smallest test set covering distinct changed behavior and safety predicates. Reassess tests tied only to removed behavior; do not preserve their combinations by moving them onto a mocked replacement. If assigned mechanics require redundant coverage or unsupported machinery, report the smaller alternative before those additions; do not silently change mandated acceptance or safety checks.
 Finish assigned task or stop only for real missing requirement or repeated verification failure.
 MUST verify every change with `lsp_diagnostics`, focused tests or typechecks when available, and `read` on changed files.
 For user-visible behavior, run a focused manual QA check when a runnable surface exists; otherwise state why not run.
````

## Validation and disposition

Prior validation covered exact P5–P6 additions, retained checks/manual QA/reviews, the zero-judgment invariant, snippet agreement, and P1–P3 patch applicability before application. P1–P3 and the Fu Xi re-audit changes are now applied. Prompt efficacy is distinct from patch and runtime verification.

Prompt efficacy remains untested; no live agent replay was run. Future validation could use small matched replays, changing one intervention at a time and checking preserved acceptance/safety, authority reuse, unnecessary machinery, and evidence validity—not test-count reduction alone. No evaluation infrastructure is proposed now.

DOX records the approved durable preferences in `agents/AGENTS.md`, `modes/AGENTS.md`, `modes/fuxi/AGENTS.md`, `extensions/AGENTS.md`, and `extensions/modes/AGENTS.md`. Fu Xi resolves all implementation decisions before handoff; workers report smaller alternatives rather than silently changing scope, acceptance, or safety checks. Root and docs owning instructions remain unchanged because ownership, indexes, and the nonbinding idea lifecycle are unchanged. P1–P3 are applied to their GPT variants; shared instructions have no model-family conditions.
