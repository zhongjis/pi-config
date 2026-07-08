# Lineage map

Which Pi persona is adapted from which upstream persona, the local files it owns, and where to fetch the upstream source. All local paths are relative to the repo root.

## Upstreams

| Tag | Repo | License |
|-----|------|---------|
| **omo** | `code-yeongyu/oh-my-openagent` | SUL 1.0 — non-commercial/internal, attribution required |
| **omo-slim** | `alvinunreal/oh-my-opencode-slim` | SUL 1.0 — non-commercial/internal, attribution required |

Never strip provenance. Cross-check with `modes/MANIFESTO.md` (which carries the omo attribution header) and `extensions/ulw/README.md` (Upstream section).

## In-scope personas

### omo → Pi

| Pi persona | Upstream | Local files |
|-----------|----------|-------------|
| Hou Tu 后土 | Atlas (orchestrator) | `modes/houtu/{mode,gpt,gemini}.md` |
| Fu Xi 伏羲 | Prometheus (planner) | `modes/fuxi/{mode,gpt,gemini}.md` + `modes/fuxi/references/*.md` |
| Kua Fu 夸父 | Sisyphus (senior eng / build) | `modes/kuafu/{mode,gpt,gemini}.md` |
| Taishang 太上老君 | Oracle (read-only consult) | `agents/taishang.md` |
| Di Renjie 狄仁杰 | Metis (gap analyzer) | `agents/direnjie.md` |
| Yanluo 阎罗 | Momus (plan reviewer) | `agents/yanluo.md` |
| Guang Guang 光光 | Sisyphus-Junior (trivial worker) | `agents/guangguang.md` |
| Chengfeng 乘风 | explore (recon) | `agents/chengfeng.md` |
| Wenchang 文昌 | librarian (doc/web research) | `agents/wenchang.md` |
| ultrawork (ulw) | ultrawork | `extensions/ulw/prompts/{default,gpt}.md` |

### omo-slim → Pi

| Pi persona | Upstream | Local files |
|-----------|----------|-------------|
| Yu Nu 玉女 | designer (frontend/UI) | `agents/yunu.md` |
| Jin Tong 金童 | fixer (bounded impl/debug) | `agents/jintong.md` |

## Out of scope (do NOT treat as omo)

| Persona | Actual lineage |
|---------|----------------|
| Lu Ban 鲁班 | Superpowers (`modes/luban/`) — prompt explicitly says do not claim Sisyphus/Prometheus/Atlas parity |
| Wei Zheng 魏征 | Superpowers (`agents/weizheng.md`) |
| Shen Nong 神農 | product-manager / pm-marketplace (`modes/shennong/`) |
| Cang Jie 仓颉 | native Pi (`agents/cangjie.md`) |

If the target is one of these, this skill does not apply.

## Fetching upstream

Open the source; do not reconstruct from memory (`.agents/AGENTS.md`: cite opened upstream sources).

- **omo** prompt bodies were observed at `packages/prompts-core/prompts/<persona>/default.md` on the `dev` branch — e.g. Atlas at `packages/prompts-core/prompts/atlas/default.md`. Raw form:
  `https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/packages/prompts-core/prompts/<persona>/default.md`
  Confirm the exact per-persona path/branch by browsing the repo — layout may drift, and some personas (explore, librarian, sisyphus-junior, ultrawork) may sit under different names or files. Use `fetch_content` on the repo tree first.
- **omo-slim** layout is not yet verified in this repo. Browse `alvinunreal/oh-my-opencode-slim` to locate the designer and fixer prompts before diffing.

Prefer `fetch_content` for raw prompt files and GitHub trees. `wenchang` can locate the exact upstream paths if the layout is unclear.

## Attribution gap (known, not auto-fixed)

In-file attribution is currently **inconsistent**:
- Present: `taishang` ("inspired by Oh My Open Agent's Oracle"), `direnjie` (Metis), `yanluo` (Momus), `fuxi` (Prometheus), `houtu` ("Pi-adapted Atlas execution conductor"), `guangguang` (description "Adapted from OmO Sisyphus-Junior"), `extensions/ulw/README.md` (Upstream section).
- **Missing**: `chengfeng` (explore), `wenchang` (librarian), `yunu` (omo-slim designer), `jintong` (omo-slim fixer) carry no lineage line.

When you next edit one of the missing ones, propose adding a one-line attribution in the same "(inspired by …)" / "Adapted from …" style — but only as part of an approved change, and confirm the exact upstream persona name against the opened source.
