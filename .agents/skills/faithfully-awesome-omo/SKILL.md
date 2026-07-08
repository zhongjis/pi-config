---
name: faithfully-awesome-omo
description: Faithfully update, polish, sync, audit, or re-adapt this repo's Pi-adapted omo / omo-slim agent and mode prompts. Use whenever working on prompts under `modes/` (Hou Tu / Fu Xi / Kua Fu ← omo Atlas / Prometheus / Sisyphus), `agents/` (Taishang / Di Renjie / Yanluo / Guang Guang / Chengfeng / Wenchang ← omo; Yu Nu / Jin Tong ← omo-slim), or `extensions/ulw/` (ultrawork) — including requests like "sync X with upstream Atlas/Prometheus/omo", "what is missing from this omo-adapted prompt", "polish / re-faithful an adapted mode", "update the gpt or gemini variant", or "align a Pi persona with its omo/omo-slim source". Trigger even when only the Pi persona name is given (Hou Tu, Fu Xi, Kua Fu, Taishang, Di Renjie, Yanluo, Guang Guang, Chengfeng, Wenchang, Yu Nu, Jin Tong) and the word "omo" is never said. Encodes the structural-faithfulness model, the omo→Pi substitution map, the mode.md / gpt.md / gemini.md family plus gemini-overlay injection anchors, the test-locked strings and DOX contracts to preserve, the recurring decision forks, and a MANDATORY proposal-first / confirm-before-apply gate. NOT for Lu Ban or Wei Zheng (Superpowers lineage), Shen Nong (product-manager lineage), or Cang Jie (native).
---

# Faithfully Awesome omo

This repo's agent personas are Pi-native adaptations of two upstream projects. This skill keeps them **honest to their upstream source** while staying **runnable on Pi** — because a naive verbatim copy breaks the runtime and the test suite, and a lazy paraphrase silently drops upstream intent. The whole job is threading that needle deliberately, then getting a human to sign off before anything lands.

All paths below are relative to the repo root (`pi-config`).

## Provenance & scope

Two upstreams, both **SUL 1.0** (non-commercial / internal use, **attribution required** — never strip provenance):

- **omo** — `code-yeongyu/oh-my-openagent`
- **omo-slim** — `alvinunreal/oh-my-opencode-slim`

A persona is **in scope only if it appears in `references/lineage-map.md`**. Read that file first — it maps each Pi persona to its exact upstream persona, upstream repo, and the local files you will touch.

Out of scope (different lineage — do not treat as omo): **Lu Ban** and **Wei Zheng** (Superpowers), **Shen Nong** (product-manager / pm-marketplace), **Cang Jie** (native). If the target is one of these, this skill does not apply — say so instead of forcing an omo frame.

## Why "faithful" is not "verbatim"

The instinct on "make it faithful to upstream" is to copy the upstream prose word-for-word in the same order. That fails here for two hard reasons — internalize both, because every decision downstream is a negotiation between them:

**Wall 1 — runtime mismatch.** Upstream prose names primitives that do not exist on Pi (`task()`, `.omo/`, `boulder.json`, `TodoWrite`, `background_output`, category+skills delegation, `explore`/`librarian` agent names). Copy them verbatim and the persona points at dead tools. Every such token must be substituted via `references/substitution-map.md`.

**Wall 2 — repo contract + locked tests.** These personas were deliberately re-architected around Pi's own mechanics, and that architecture is codified as binding contract (`modes/AGENTS.md`, `agents/AGENTS.md`, `extensions/*/AGENTS.md`) and pinned by tests (`test/fuxi-clearance.test.ts`, `extensions/modes/test/`, `extensions/ulw/test/`). Reverting to an upstream wording that contradicts those breaks the build and violates the DOX contract. See `references/constraints-and-forks.md`.

So the achievable target is **structural faithfulness**: adopt the upstream section **order, names, prose, tone, and examples** for everything tool-agnostic; substitute runtime tokens via the fixed map; keep the Pi-mandated mechanics as the substituted content. Where upstream and the Pi architecture genuinely conflict on behavior (retry policy, section count, upstream-only sections), that is a **decision fork** — surface it, do not silently pick a side.

## Workflow

### 0. Orient
- Identify the target persona(s) and which prompt files they own (`references/lineage-map.md`).
- Read the owning `AGENTS.md` chain top-down (root → `modes/` or `agents/` or `extensions/` → nearest owner). The nearest one controls local rules; parents still bind. This is mandatory before edits — it tells you what is contract vs. free.

### 1. Fetch upstream and diff
- Fetch the current upstream source for the mapped persona (URLs in `references/lineage-map.md`). Open it — do not reconstruct upstream behavior from memory.
- Diff upstream against the current Pi prompt **and its family variants** (`mode.md` + `gpt.md` + `gemini.md`, or the single agent `.md`, or `extensions/ulw/prompts/{default,gpt}.md`).

### 2. Classify every difference
Sort each gap into one bucket — this classification is the real intellectual work:
- **Real gap** — upstream has a concept Pi dropped by accident or omission. Candidate to restore.
- **Runtime substitution** — same concept, different tool noun. Apply the map; not a fork.
- **Intentional Pi divergence** — Pi deliberately differs (see the fork list in `references/constraints-and-forks.md`). Do not "fix" it silently; confirm whether to keep or revert.
- **Upstream-only-runtime** — depends on an upstream runtime Pi lacks (e.g. `boulder.json` completion tracking). Usually drop; confirm.

### 3. Draft the adaptation
- Apply `references/substitution-map.md` consistently.
- Preserve, without exception: **test-locked strings**, **Pi agent/mode names**, **owning-`AGENTS.md` mechanics**, the **`<role>` / `<critical>` injection anchors** (see substitution map — the Gemini overlay is injected before the first `<critical>`, else after `</role>`; lose those anchors and the corrective overlay falls to the bottom of the prompt), and **attribution-only** upstream mentions.
- Keep all three family variants aligned in intent (they may differ in wording per the Default / GPT / Gemini philosophy in `modes/MANIFESTO.md`).

### 4. Proposal + confirm gate — MANDATORY
Never edit a persona prompt before the user approves the plan. This is the core discipline of this skill: these prompts are load-bearing and shared, and a wrong "faithful" call is expensive to unwind. Present, concisely:
- the upstream→Pi section mapping and what changes,
- files to be touched (all family variants),
- test-locked strings you will preserve,
- each **decision fork** with a recommended default and the tradeoff,
- anything upstream you are intentionally dropping and why.

Then wait for an explicit go. If the plan needs a change to a locked contract file (e.g. `modes/AGENTS.md`) or a test, call that out as "Ask First" territory and get separate approval.

### 5. Implement the family in lockstep
- Edit `mode.md` (canonical: frontmatter + default body), `gpt.md` (self-contained body-only replacement), and `gemini.md` (corrective overlay) together — never leave the matrix inconsistent.
- For agents it is a single `.md`; for ulw it is `extensions/ulw/prompts/{default,gpt}.md`.
- Match existing formatting; make the smallest change that satisfies the approved plan.

### 6. Verify (evidence, not vibes)
- `pnpm vitest run test/fuxi-clearance.test.ts` (mode family matrix + locked strings). Add `extensions/ulw/test/` and `extensions/modes/test/` when those are touched.
- `pnpm lint:typecheck`.
- Grep for stray upstream mentions (only the sanctioned attribution line may remain) and stale substituted tokens (`ACCUMULATED CONTEXT`, `boulder`, `task(`, `.omo/`, `TodoWrite`, etc. — whichever you removed).
- Reread the **final injected/composed prompt**, not just source fragments (per `modes/AGENTS.md`). Confirm the Gemini overlay lands before `<critical>`.

### 7. DOX pass
- If you changed structure, ownership, a contract, section counts, or mechanics, update the nearest owning `AGENTS.md` and any parent/child index. If nothing contract-level changed, say so.

## References

- `references/lineage-map.md` — which Pi persona ← which upstream persona, files, fetch URLs, out-of-scope, attribution-gap notes.
- `references/substitution-map.md` — omo/omo-slim→Pi token map, family matrix, Gemini-overlay injection anchor rule, Default/GPT/Gemini philosophy.
- `references/constraints-and-forks.md` — test-locked strings, DOX contracts to respect, attribution rule, and the recurring decision forks with this repo's defaults.

## Verify commands (quick copy)

```bash
pnpm vitest run test/fuxi-clearance.test.ts
pnpm lint:typecheck
# stray upstream / stale tokens (adjust the alternation to what you removed):
rg -n "Atlas|Prometheus|Sisyphus|Momus|Metis|Oracle|boulder|task\(|\.omo/|TodoWrite|background_output|ACCUMULATED CONTEXT" modes/ agents/ extensions/ulw/
```
