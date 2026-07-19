# Adapt & promote a persona (archive/source → adapt → verify)

The end-to-end flow for bringing an omo persona faithfully onto Pi. **Generic for any persona in `lineage-map.md`.** Atlas → Hou Tu is the worked example at the bottom.

## The three moves (the "adding flow")

**1. Refresh/read the baseline.**
For agent/mode personas, run `pnpm sync:oh-my-openagent-prompts` when refreshing `docs/references/oh-my-openagent/final-prompts/`; verify with `pnpm check:oh-my-openagent-prompts`. Use the matching generated final rendered prompt at the pinned SHA as your diff baseline and provenance record. For ultrawork, no final prompt is archived; fetch the direct commit-pinned upstream source per `lineage-map.md`. Never hand-edit generated archive files.

**2. Compare & propose.**
`diff` the correct baseline against the current Pi prompt **and all its variants**: generated final prompt for agent/mode personas; direct pinned upstream source for ultrawork. Classify each gap (real gap / runtime substitution / intentional divergence / upstream-only-runtime — SKILL.md step 2). Present the section mapping, the decision forks with recommended defaults, the test-locked strings you will preserve, and anything you will drop. Wait for the go (SKILL.md step 4).

**3. Adapt — pick the method by change size.**
- **Large change → copy-then-adapt.** Copy the baseline over the target, then transform in place — generated final prompt from `docs/references/oh-my-openagent/final-prompts/<agent>/<variant>.md` for agent/mode personas; direct pinned upstream source for ultrawork. For a full default-body rebuild, do it as a scratch file first (e.g. `mode-v2.md`) so the adaptation is diffable against the baseline and reviewable before it touches the live prompt.
- **Small change → edit in place.**

Apply the adaptation rules while you transform: `substitution-map.md`, section-order parity, preserved test-locked strings, the `<role>`/`<critical>` Gemini anchor, policy-verbose/mechanics-lean, decision forks (SKILL.md step 3 + the two maps).

## Variant shapes (modes)
- `mode.md` — canonical: frontmatter + full default (Claude-family) body. Adapt the generated final `<agent>/default.md` prompt.
- `gpt.md` — self-contained **body-only replacement** (inherits `mode.md` frontmatter; must NOT start with `---`; must NOT contain the `defaultOnly` string). Adapt the generated final `<agent>/gpt.md` prompt.
- `gemini.md` — corrective **overlay**, not a full body. **Distill** the generated final `<agent>/gemini.md` prompt's Gemini-specific corrections (tool-grounding, never-implement, scope-lock, premature-termination) into the overlay. A verbatim copy of the full upstream gemini body would break the injector — the distilled overlay is the faithful adaptation for that slot.
- agents: a single `.md` from the matching generated final prompt. ulw: `extensions/ulw/prompts/{default,gpt}.md` from direct commit-pinned upstream source, not the generated archive.

## Architecture gate (rebuild / promotion)
Before promoting a rebuilt default body, consult `taishang` for read-only architecture review: faithfulness to upstream, Pi-runtime correctness against the extension source, internal consistency, `allow_delegation_to` coverage, and promotion-readiness. Taishang remains an architecture/debugging consult and F1 plan-compliance auditor only, NEVER code-quality reviewer. The orchestrator retains the **orchestrator-owned code-quality gate**, including executable checks and diff-vs-requirements review. Fix every BLOCKER/MAJOR before promoting.

## Promote (full rebuild)
- Swap the scratch into place (`mv mode-v2.md mode.md`) — swap-ready because it carries the test-locked strings.
- Rebuild `gpt.md` + `gemini.md` with the **same** baseline→adapt approach (don't leave the family half-migrated).
- **Sync every duplicate test table.** Per-mode invariants are asserted in BOTH `test/fuxi-clearance.test.ts` AND `extensions/modes/test/hooks.test.ts`; they drift independently. Update both, or one stays red.

## Verify (the recipe — capture evidence for each)
- **Section-order parity:** `paste <(rg -o '^<[a-zA-Z_]+>' <baseline>) <(rg -o '^<[a-z_]+>' <adapted>)` → shared sections line up 1:1.
- **Substitution sweep:** `rg -n 'task\(|\.omo/|bg_|ses_|TodoWrite|boulder|background_output|subagent_type="explore"|subagent_type="librarian"' <adapted>` → none.
- **Test-locked strings present** — grep each straight from the test file (the test is the source of truth, not any copy in these references).
- **No upstream-name leak:** `rg -ni 'atlas|ohmyopencode|prometheus|sisyphus|oracle' <adapted>` → none (bar a sanctioned attribution line).
- **`allow_delegation_to` ⊇ every plan-specified delegated reviewer/worker** (constraints-and-forks → gate map). A missing delegated agent is a silent runtime denial, not a build failure; F2 stays orchestrator-owned.
- **Baseline / no-regression:** capture the modes test trio (`fuxi-clearance` + `hooks` + `config-loader`) pass/fail BEFORE editing; prove no regression AFTER. A pre-existing red stays flagged and out of scope unless the user asks.

## Worked example — Hou Tu 后土 (← Atlas)
Generated `atlas/{default,gpt,gemini}.md` final prompts (commit pinned by `docs/references/oh-my-openagent/README.md`). Default: copy-then-adapt via scratch `mode-v2.md` → `taishang` review → `mv` to `mode.md`. `gpt.md`: `cp atlas/gpt.md` → adapt (full GPT body). `gemini.md`: distilled overlay from `atlas/gemini.md` (not a verbatim copy). Synced houtu invariants in BOTH `fuxi-clearance.test.ts` and `hooks.test.ts`; added the F4 reviewer `direnjie` to `allow_delegation_to`.
