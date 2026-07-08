# Constraints & decision forks

What you must not break, and the judgment calls that recur every time you adapt an omo persona.

## Test-locked strings (source of truth: the test files)

These tests assert exact substrings in the composed prompts. Break a string → red build. **Read the test before editing** — the lists drift, so treat the test file as authoritative rather than trusting any copy here.

- `test/fuxi-clearance.test.ts` — the mode family matrix. Per mode it locks `default[]`, `gpt[]`, `geminiOverlay[]`, `geminiComposed[]`, and `defaultOnlyInGptReplacement` (a string that must be in `mode.md` but absent from `gpt.md`). Covers `kuafu`, `fuxi`, `houtu`, `luban`.
- `extensions/modes/test/hooks.test.ts` — mirrors the overlay injection (anchor positioning) and per-mode overlay strings.
- `extensions/ulw/test/index.test.ts` — ulw prompt assertions.

Worked example (houtu, so you see the shape):
- `default`: `You execute by coordinating, delegating, and verifying` · `One \`TaskExecute\` launch = one bounded plan task` · `Final Verification Wave is an approval gate`
- `gpt`: `Read \`local://PLAN.md\` before doing anything else` · `One \`TaskExecute\` launch = one bounded plan task` · `Final Verification Wave is mandatory approval gate` · `APPROVE`
- `geminiOverlay`: `<gemini-corrective-overlay>` · `Do not become the implementer` · `Final Verification Wave requires explicit \`APPROVE\``
- `defaultOnlyInGptReplacement`: `TASK ANALYSIS:` (must be in `mode.md`, must NOT be in `gpt.md`)

Before finalizing, grep the test for the mode you touched and confirm every locked string still appears (and the `defaultOnly…` string is absent from `gpt.md`).

## DOX contracts to respect (editing these is "Ask First")

The owning `AGENTS.md` files encode binding architecture. Do not weaken them, and get explicit approval before editing them.

- `modes/AGENTS.md` — the heavy one. For **Hou Tu**: per-task pi-task DAG (not per-wave), `TaskCreate`→`TaskUpdate addBlockedBy`→`TaskExecute`, the **6-section** delegation contract, `max_turns` as the only cost guard, retries re-run fresh (never `Agent(resume)`), `autoCascade` OFF, and the invariant `One TaskExecute launch = one bounded plan task` (test-asserted). For **Fu Xi**: exactly 7 planning steps, the reference-split router, and plan-ceremony strings that must stay in the router files (not the `references/`). Also: keep the CodeGraph / LSP / `rg`,`fd` tool-split; frontend→`yunu`, non-UI impl→`jintong`.
- `agents/AGENTS.md` — agent frontmatter + prompt conventions.
- `extensions/AGENTS.md` and `extensions/ulw/` docs — ulw event/prompt rules.

After a contract-level change (structure, section count, mechanics, ownership), update the nearest owning `AGENTS.md`. If nothing contract-level changed, say so.

## Attribution rule

Keep exactly one sanctioned upstream mention per persona (the attribution line — see `lineage-map.md` for which lines exist). Purge every other upstream-persona-name mention; rename to the Pi persona. Keep Pi agent/mode names everywhere. Never remove provenance entirely (`.agents/AGENTS.md`: preserve provenance when adapting).

## Recurring decision forks (surface these; do not silently pick)

When upstream and the Pi architecture disagree on behavior, present the fork in the proposal with this repo's default and the tradeoff. Do not auto-revert to upstream, and do not silently keep the Pi choice without flagging it.

| Fork | Upstream | Repo default | Why the default |
|------|----------|--------------|-----------------|
| Retry policy | "no cap, push through, no excuses" | **≤3 retries, then log blocker + move to independent work** | `max_turns` is the only runaway guard on Pi; unbounded retry risks cost blowup + loops |
| Delegation contract sections | 6 sections (Inherited Wisdom as a `CONTEXT` sub-part) | **6 sections** (Hou Tu folded a prior 7→6; Inherited Wisdom lives in `CONTEXT`) | matches upstream count and Pi register-early/refresh-late model |
| Upstream-runtime-only sections (boulder completion, elapsed summary) | present | **drop**, replace with plain final summary | no Pi boulder runtime |
| Parallel framing | aggressive "PARALLEL by default; what is BLOCKING me from firing all in one message?" | **restore the aggressive framing** | throughput; Pi `TaskExecute` supports multi-`task_ids` batches |
| 30-line prompt cue | "if under 30 lines it's TOO SHORT" | **restore as a cue**, balanced with "length ≠ quality" | nudges completeness without encouraging padding |
| Resume mechanic | resume same session via `task_id` | **fresh re-run via `TaskExecute`, never `Agent(resume)`** | NOT a fork — runtime-forced + contract-locked; always Pi-side |

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
- [ ] `<role>` + early `<critical>` anchors preserved in adapted mode bodies
- [ ] Test-locked strings for the touched mode preserved; `defaultOnly…` string absent from `gpt.md`
- [ ] Pi persona names kept; only the sanctioned attribution line mentions upstream
- [ ] All family variants (`mode`/`gpt`/`gemini`, or agent `.md`, or ulw pair) changed in lockstep
- [ ] Each decision fork surfaced with a recommended default
- [ ] Any locked-contract / test edit called out as "Ask First"
