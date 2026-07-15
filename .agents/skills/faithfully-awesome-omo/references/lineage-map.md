# Lineage map

Which Pi persona is adapted from which upstream persona/category, the local files it owns, and where to fetch the upstream source. All local paths are relative to the repo root.

## Upstream

One upstream. Everything in scope is **omo**.

| Tag | Repo | License |
|-----|------|---------|
| **omo** | `code-yeongyu/oh-my-openagent` | SUL 1.0 — non-commercial/internal, attribution required |

Never strip provenance. Cross-check with `modes/MANIFESTO.md` (carries the omo attribution header) and `extensions/ulw/README.md` (Upstream section).

## In-scope: standalone omo agents/modes → Pi

| Pi persona | omo | Local files |
|-----------|-----|-------------|
| Hou Tu 后土 | Atlas (orchestrator) | `modes/houtu/{mode,gpt,gemini}.md` |
| Fu Xi 伏羲 | Prometheus (planner) + `ulw-plan` runtime skill ceremony | thin routers `modes/fuxi/{mode,gpt,gemini}.md`; adapted runtime skill `modes/fuxi/skills/ulw-plan/{SKILL.md,references/*}`; pinned raw baselines `docs/references/omo-prompts/{prometheus,ulw-plan}` |
| Kua Fu 夸父 | Sisyphus (senior eng — the primary coding agent) | `modes/kuafu/{mode,gpt,gemini}.md` |
| Taishang 太上老君 | Oracle (read-only consult) | `agents/taishang.md` |
| Di Renjie 狄仁杰 | Metis (gap analyzer) | `agents/direnjie.md` |
| Yanluo 阎罗 | Momus (plan reviewer) | `agents/yanluo.md` |
| Chengfeng 乘风 | explore (recon) | `agents/chengfeng.md` |
| Wenchang 文昌 | librarian (doc/web research) | `agents/wenchang.md` |
| ultrawork (ulw) | ultrawork | `extensions/ulw/prompts/{default,gpt}.md` |

Note on Taishang: realigned toward Oracle — read-only architecture/debugging consult + F1 plan-compliance only at `:medium` effort (Oracle runs medium), NEVER code-quality reviewer. F2 is the **orchestrator-owned code-quality gate**: the orchestrator runs executable checks and performs diff-vs-requirements review. omo likewise keeps code review inline in Atlas/Sisyphus, with no dedicated reviewer. Taishang keeps richer inspection tools (`readonly_bash`/`codegraph_*`/`lsp`) than Oracle — an intentional Pi enhancement. This is close to Oracle; not a drift to "fix".

## In-scope: Sisyphus-Junior categories → Pi worker agents

Key correction: **Sisyphus-Junior is not an agent with named "variants."** It is a single **category-spawned executor** — one base worker whose model, fallback chain, and prompt append are selected by the **task category** passed to it. omo defines 8 built-in categories. The Pi worker agents are Pi adaptations of individual categories:

| Pi agent | omo Sisyphus-Junior category | omo category model | Local file |
|----------|------------------------------|--------------------|------------|
| Guang Guang 光光 | `quick` | gpt-5.4-mini | `agents/guangguang.md` |
| Jin Tong 金童 | `unspecified-low` | claude-sonnet | `agents/jintong.md` |
| Ju Ling 巨灵神 | `unspecified-high` | claude-opus (max) | `agents/juling.md` |
| Yu Nu 玉女 | `visual-engineering` | gemini-3.1-pro (high) | `agents/yunu.md` |

**Unclaimed omo categories** (no Pi persona — map deliberately if a need arises):
- `artistry` (gemini high) — wild/unconventional creative exploration; distinct from `visual-engineering`'s prescriptive design-system-first discipline.
- `deep` (gpt-5.5 medium) — autonomous problem-solving.
- `ultrabrain` (gpt-5.5 xhigh) — maximum reasoning.
- `writing` (gemini-3-flash) — docs/prose.

`visual-engineering` vs `artistry` (recurring confusion): visual-engineering = prescriptive + systemic (design system → tokens → consistency); artistry = exploratory + unconventional (radical directions, break patterns). Yu Nu maps to visual-engineering.

## Out of scope (do NOT treat as omo)

| Persona | Actual lineage |
|---------|----------------|
| Lu Ban 鲁班 | Superpowers (`modes/luban/`) — explicitly disclaims Sisyphus/Prometheus/Atlas parity |
| Shen Nong 神農 | product-manager / pm-marketplace (`modes/shennong/`) |

## Fetching upstream

Open the source; do not reconstruct from memory (`.agents/AGENTS.md`: cite opened upstream sources). Two roots matter:

- **Prompt markdown** — `packages/prompts-core/prompts/<persona>/default.md`. Confirmed present: `atlas`, `prometheus`, `ultrawork`, and `mode/` (hyperplan, team). Confirm exact per-persona paths by browsing; layout drifts.
- **Agent + category code** (where Sisyphus-Junior, Oracle, and the category models/prompts live):
  - `packages/omo-opencode/src/agents/` — e.g. `sisyphus-junior/default.ts`, `oracle.ts`, `builtin-agents.ts`
  - `packages/omo-opencode/src/tools/delegate-task/*-categories.ts` — per-family category prompt appends (e.g. `google-categories.ts` holds `visual-engineering` and `artistry`)
  - `packages/model-core/src/category-model-requirements.ts` — category → model + fallback chain
  - `packages/model-core/src/agent-model-requirements.ts` — standalone agent + mode chains (oracle/metis/momus/explore/librarian, sisyphus/atlas/prometheus/hephaestus) → model + effort. Pair with `category-model-requirements.ts` for the full model/effort picture.

Raw pattern: `https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/<path>`. Use `fetch_content` on the GitHub tree/API first; `wenchang` can locate exact paths when the layout is unclear.

After fetching, **vendor** the persona's variants into `docs/references/omo-prompts/<agent>/*.md` (byte-identical, commit-pinned — see that dir's README) so the diff baseline is a fixed, reproducible artifact rather than an ephemeral fetch. `<agent>` is the upstream name (`atlas`, `prometheus`, …), not the Pi persona. For Fu Xi, the active baseline is split: Prometheus prompt at `docs/references/omo-prompts/prometheus/` plus `ulw-plan` skill snapshot at `docs/references/omo-prompts/ulw-plan/`. The adapted runtime skill lives under `modes/fuxi/skills/ulw-plan/`; Fu Xi's mode files stay thin routers. The full vendor → adapt → promote flow lives in `references/adapt-and-promote.md`.

## Attribution gap (known, not auto-fixed)

In-file attribution is **inconsistent**:
- Present: `taishang` (Oracle), `direnjie` (Metis), `yanluo` (Momus), `fuxi` (Prometheus), `houtu` ("Pi-adapted Atlas execution conductor"), `guangguang` (desc "Adapted from OmO Sisyphus-Junior"), `juling` (desc "Pi mapping of omo Sisyphus-Junior's `unspecified-high` category"), `extensions/ulw/README.md`.
- **Missing**: `chengfeng` (explore), `wenchang` (librarian), `yunu` (Sisyphus-Junior `visual-engineering`), `jintong` (Sisyphus-Junior `unspecified-low`).

When you next edit one of the missing ones, propose adding a one-line attribution ("(inspired by omo's …)" / "Pi mapping of omo Sisyphus-Junior's `<category>` category"), verified against the opened source, as part of an approved change.
