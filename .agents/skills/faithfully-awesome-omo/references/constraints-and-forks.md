# Constraints & decision forks

What you must not break, and the judgment calls that recur every time you adapt an omo persona.

## Test-locked strings (source of truth: the test files)

These tests assert exact substrings in the composed prompts. Break a string → red build. **Read the test before editing** — the lists drift, so treat the test file as authoritative rather than trusting any copy here.

- `test/fuxi-clearance.test.ts` — the mode family matrix. Per mode it locks `default[]`, `gpt[]`, `geminiOverlay[]`, `geminiComposed[]`, and `defaultOnlyInGptReplacement` (a string that must be in `mode.md` but absent from `gpt.md`). Covers `kuafu`, `fuxi`, `houtu`, `luban`.
- `extensions/modes/test/hooks.test.ts` — **carries its own copy** of the per-mode invariant table (`default`/`gpt`/`geminiOverlay`/`defaultOnly`) plus overlay-anchor positioning. It drifts independently from `fuxi-clearance.test.ts` — when a locked string changes, **sync both** or one stays red.
- `extensions/ulw/test/index.test.ts` — ulw prompt assertions.

Worked example (houtu, so you see the shape):
- `default`: `You execute by coordinating, delegating, and verifying` · `Pi-tasks track plan identity, dependencies, and verified status only` · `Delegate all plan work directly with \`Agent\`` · `Never use \`TaskExecute\`, \`TaskOutput\`, or \`TaskStop\`` · `Final Verification Wave gate`
- `gpt`: `Read \`local://PLAN.md\` before doing anything else` · `Use pi-tasks only for logical tracking` · `Launch plan work with \`Agent\`` · `Never use \`TaskExecute\`, \`TaskOutput\`, or \`TaskStop\`` · `Final Verification Wave is a mandatory approval gate` · `APPROVE`
- `geminiOverlay`: `<gemini-corrective-overlay>` · `Hou Tu coordinates only` · `Pi-tasks track logical PLAN work only` · `Delegate one bounded plan task per \`Agent\` session` · `Final Verification Wave reviewer returns explicit \`APPROVE\``
- `defaultOnlyInGptReplacement`: `<tracking_contract>` (must be in `mode.md`, must NOT be in `gpt.md`)

Before finalizing, grep the test for the mode you touched and confirm every locked string still appears (and the `defaultOnly…` string is absent from `gpt.md`).

## DOX contracts to respect (editing these is "Ask First")

The owning `AGENTS.md` files encode binding architecture. Do not weaken them, and get explicit approval before editing them.

- `modes/AGENTS.md` — the heavy one. For **Hou Tu**: strict pi-task/agent lifecycle separation — pi-tasks are logical DAG only (`TaskCreate` per top-level item → `TaskUpdate addBlockedBy` → `in_progress` before delegation → `completed` only after Hou Tu independently verifies evidence); plan work runs **directly through `Agent`**, supervised via `get_subagent_result`/`steer_subagent`, with `Agent(resume)` for salvageable workstreams; **never `TaskExecute`/`TaskOutput`/`TaskStop`**, never store agent IDs/runtime state in task metadata; the **6-section** delegation contract; independent tasks launch as separate background agents; task status + PLAN checkboxes are the authoritative verified-work state. For **Fu Xi**: thin router files `modes/fuxi/{mode,gpt,gemini}.md`; adapted runtime skill `modes/fuxi/skills/ulw-plan/{SKILL.md,references/*}`; pinned raw baselines `docs/references/omo-prompts/{prometheus,ulw-plan}`; runtime injection via the modes extension; exactly 7 planning steps in the skill; no Fu Xi reference material beside the router files. Also: keep the CodeGraph / LSP / `rg`,`fd` tool-split; frontend→`yunu`, non-UI impl→`jintong`; Taishang remains architecture/debugging consult + F1 plan-compliance only, NEVER code-quality reviewer.
- `agents/AGENTS.md` — agent frontmatter + prompt conventions.
- `extensions/AGENTS.md` and `extensions/ulw/` docs — ulw event/prompt rules.

After a contract-level change (structure, section count, mechanics, ownership), update the nearest owning `AGENTS.md`. If nothing contract-level changed, say so.

## Final verification gates (`allow_delegation_to` must cover delegated agents)

An orchestration/execution mode can only delegate to agents listed in its frontmatter `allow_delegation_to`; anything else is **denied at runtime** by the delegation policy — a silent stall at run time, not a build error. Fu Xi's injected `modes/fuxi/skills/ulw-plan/SKILL.md` pins the Final Verification Wave gates. F2 is the **orchestrator-owned code-quality gate**: the orchestrator runs executable checks and performs diff-vs-requirements review; it does not delegate F2 to a dedicated reviewer.

| Gate | Owner |
|------|-------|
| F1 plan-compliance | `taishang` — F1 only; NEVER code-quality reviewer |
| F2 code-quality | orchestrator |
| F3 real manual QA | `yunu` (UI) / `jintong` (CLI/API) |
| F4 scope-fidelity | `direnjie` |

So Hou Tu (and any execution persona) MUST list every delegated F1/F3/F4 agent in `allow_delegation_to` — the F4 `direnjie` gap silently stalled the Final Wave until caught. When adapting any orchestration/execution persona, cross-check its allowlist against every reviewer/worker its body tells it to delegate to.

## Attribution rule

Keep exactly one sanctioned upstream mention per persona (the attribution line — see `lineage-map.md` for which lines exist). Purge every other upstream-persona-name mention; rename to the Pi persona. Keep Pi agent/mode names everywhere. Never remove provenance entirely (`.agents/AGENTS.md`: preserve provenance when adapting).

## Recurring decision forks (surface these; do not silently pick)

When upstream and the Pi architecture disagree on behavior, present the fork in the proposal with this repo's default and the tradeoff. Do not auto-revert to upstream, and do not silently keep the Pi choice without flagging it.

| Fork | Upstream | Repo default | Why the default |
|------|----------|--------------|-----------------|
| Retry policy | "no cap, push through, no excuses" | **no cap — resume/repair until verified; only stop for a genuine external blocker** | Atlas-faithful; per-run `max_turns`/turn limits are the runaway guard, so an outer attempt cap is unneeded and would abandon unverified work |
| Delegation contract sections | 6 sections (Inherited Wisdom as a `CONTEXT` sub-part) | **6 sections** (Hou Tu folded a prior 7→6; Inherited Wisdom lives in `CONTEXT`) | matches upstream count and Pi register-early/refresh-late model |
| Upstream-runtime-only sections (boulder completion, elapsed summary) | present | **drop**, replace with plain final summary | no Pi boulder runtime |
| Parallel framing | aggressive "PARALLEL by default; what is BLOCKING me from firing all in one message?" | **restore the aggressive framing** | throughput; independent workers fan out as parallel background `Agent` calls, collected with `get_subagent_result` |
| 30-line prompt cue | "if under 30 lines it's TOO SHORT" | **drop the hard floor; require completeness — "self-contained, everything the stateless worker needs and nothing it does not"** | line-count is a poor proxy; completeness is the real target and avoids padding |
| Resume mechanic | resume same session via `task_id` | **resume via `Agent(resume: agentId)` for salvageable workstreams; fresh worker only when unsalvageable** | NOT a fork — runtime + contract; `Agent(resume)` is the Pi mechanism and `TaskExecute` is forbidden |

The last row is listed so you recognize it in upstream prose and substitute it automatically — it is not a choice.

### Model + effort alignment forks

Model/effort alignment (see `substitution-map.md` → *Effort / reasoning-level mapping* + *Model-chain alignment method*) has its own recurring calls:

| Fork | Upstream | Repo default | Why |
|------|----------|--------------|-----|
| Opus version | uniformly `claude-opus-4-7` | **keep repo newest (`4-8`); bump only `4-6 → 4-7`** | repo standardizes on latest opus; never downgrade `4-8` |
| Untagged effort | omo leaves most fallbacks untagged (≈ default) | **strip the Pi suffix (= default), NOT `:off`** | Pi untagged = provider/session default; forcing `:off` disables reasoning |
| Chain composition | role-specific raw models (glm/kimi/minimax/big-pickle) | **house provider-ladder (deepseek/qwen2.5-coder); align per-family effort only, never reorder** | omo's raw models mostly don't exist in this repo's providers |

## Non-negotiables checklist (pre-proposal)

- [ ] Every runtime token substituted (`references/substitution-map.md`)
- [ ] Gemini overlay anchor kept: an early `<critical>` (preferred — peak-attention) or at least `</role>` (fallback). Upstream tag names alone (`<identity>`/`<mission>`/`<critical_overrides>`) do NOT match `indexOf("<critical>")`
- [ ] Test-locked strings for the touched mode preserved; `defaultOnly…` string absent from `gpt.md`
- [ ] Pi persona names kept; only the sanctioned attribution line mentions upstream
- [ ] All family variants (`mode`/`gpt`/`gemini`, agent `.md`, ulw pair, or Fu Xi router + `skills/ulw-plan` runtime skill) changed in lockstep
- [ ] Each decision fork surfaced with a recommended default
- [ ] Any locked-contract / test edit called out as "Ask First"
- [ ] `allow_delegation_to` ⊇ every delegated reviewer/worker (Final Wave F1/F3/F4; F2 stays orchestrator-owned)
- [ ] Both invariant tables synced (`fuxi-clearance.test.ts` + `hooks.test.ts`) if any locked string changed
