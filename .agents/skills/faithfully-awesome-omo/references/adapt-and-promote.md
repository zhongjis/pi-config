# Adapt & promote a persona (vendor → adapt → verify)

The end-to-end flow for bringing an omo persona faithfully onto Pi. **Generic for any persona in `lineage-map.md`.** Atlas → Hou Tu is the worked example at the bottom.

## The three moves (the "adding flow")

**1. Vendor upstream (all variants).**
Copy every upstream variant into `docs/references/omo-prompts/<agent>/*.md`, byte-identical, commit-pinned (see that dir's README). This fixed artifact is your diff baseline and your provenance record — diff against it, not against an ephemeral fetch or memory. `cmp` each copy against source (or verify via the fetch).

**2. Compare & propose.**
`diff` the vendored upstream against the current Pi prompt **and all its variants**. Classify each gap (real gap / runtime substitution / intentional divergence / upstream-only-runtime — SKILL.md step 2). Present the section mapping, the decision forks with recommended defaults, the test-locked strings you will preserve, and anything you will drop. Wait for the go (SKILL.md step 4).

**3. Adapt — pick the method by change size.**
- **Large change → copy-then-adapt.** `cp docs/references/omo-prompts/<agent>/<variant>.md <target>`, then transform in place — you start from real upstream, not the current file or memory. For a full default-body rebuild, do it as a scratch file first (e.g. `mode-v2.md`) so the adaptation is diffable against the vendored upstream and reviewable before it touches the live prompt.
- **Small change → edit in place.**

Apply the adaptation rules while you transform: `substitution-map.md`, section-order parity, preserved test-locked strings, the `<role>`/`<critical>` Gemini anchor, policy-verbose/mechanics-lean, decision forks (SKILL.md step 3 + the two maps).

## Variant shapes (modes)
- `mode.md` — canonical: frontmatter + full default (Claude-family) body. Adapt `<agent>/default.md`.
- `gpt.md` — self-contained **body-only replacement** (inherits `mode.md` frontmatter; must NOT start with `---`; must NOT contain the `defaultOnly` string). Adapt `<agent>/gpt.md`.
- `gemini.md` — corrective **overlay**, not a full body. **Distill** `<agent>/gemini.md`'s Gemini-specific corrections (tool-grounding, never-implement, scope-lock, premature-termination) into the overlay. A verbatim copy of the full upstream gemini body would break the injector — the distilled overlay is the faithful adaptation for that slot.
- agents: a single `.md`. ulw: `extensions/ulw/prompts/{default,gpt}.md`.

## Review gate (rebuild / promotion)
Before promoting a rebuilt default body, consult `taishang` (read-only architecture review): faithfulness to upstream, Pi-runtime correctness against the extension source, internal consistency, `allow_delegation_to` coverage, and promotion-readiness. Fix every BLOCKER/MAJOR before promoting.

## Promote (full rebuild)
- Swap the scratch into place (`mv mode-v2.md mode.md`) — swap-ready because it carries the test-locked strings.
- Rebuild `gpt.md` + `gemini.md` with the **same** vendor→adapt approach (don't leave the family half-migrated).
- **Sync every duplicate test table.** Per-mode invariants are asserted in BOTH `test/fuxi-clearance.test.ts` AND `extensions/modes/test/hooks.test.ts`; they drift independently. Update both, or one stays red.

## Verify (the recipe — capture evidence for each)
- **Section-order parity:** `paste <(rg -o '^<[a-zA-Z_]+>' <vendored-upstream>) <(rg -o '^<[a-z_]+>' <adapted>)` → shared sections line up 1:1.
- **Substitution sweep:** `rg -n 'task\(|\.omo/|bg_|ses_|TodoWrite|boulder|background_output|subagent_type="explore"|subagent_type="librarian"' <adapted>` → none.
- **Test-locked strings present** — grep each straight from the test file (the test is the source of truth, not any copy in these references).
- **No upstream-name leak:** `rg -ni 'atlas|ohmyopencode|prometheus|sisyphus|oracle' <adapted>` → none (bar a sanctioned attribution line).
- **`allow_delegation_to` ⊇ every plan-specified reviewer** (constraints-and-forks → reviewer map). A missing reviewer is a silent runtime denial, not a build failure.
- **Baseline / no-regression:** capture the modes test trio (`fuxi-clearance` + `hooks` + `config-loader`) pass/fail BEFORE editing; prove no regression AFTER. A pre-existing red stays flagged and out of scope unless the user asks.

## Worked example — Hou Tu 后土 (← Atlas)
Vendored `atlas/{default,gpt,gemini}.md` (commit `830ec1e`). Default: copy-then-adapt via scratch `mode-v2.md` → `taishang` review → `mv` to `mode.md`. `gpt.md`: `cp atlas/gpt.md` → adapt (full GPT body). `gemini.md`: distilled overlay from `atlas/gemini.md` (not a verbatim copy). Synced houtu invariants in BOTH `fuxi-clearance.test.ts` and `hooks.test.ts`; added the F4 reviewer `direnjie` to `allow_delegation_to`.
