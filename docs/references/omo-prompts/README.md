# omo upstream prompts (vendored reference)

Byte-identical, commit-pinned copies of upstream omo (`code-yeongyu/oh-my-openagent`) prompts, kept for citation and as the **diff baseline** when adapting a persona into its Pi counterpart. Used by the `faithfully-awesome-omo` skill; the persona↔upstream mapping lives in that skill's `references/lineage-map.md`.

## Layout convention (generic — every omo persona)

One subdirectory per upstream persona/agent; one file per variant:

```
omo-prompts/<agent>/*.md
# modes with variants:  <agent>/{default,gpt,gemini}.md
# single-file agents:   <agent>/default.md
```

`<agent>` is the upstream name (e.g. `atlas`, `prometheus`, `sisyphus`, `oracle`, `metis`, `momus`, `explore`, `librarian`), not the Pi persona name. Copies are byte-identical to upstream — never edit them.

## Vendoring a new persona

1. Look up the upstream name + source path in `faithfully-awesome-omo/references/lineage-map.md`.
2. Copy every variant into `omo-prompts/<agent>/` and pin the commit under **Vendored sets** below.
3. `cmp` each copy against source (or verify via the fetch), then diff it against the current Pi prompt to drive the adaptation.

Re-copy from a pinned commit to refresh; never hand-edit a vendored file.

## Vendored sets

### `atlas/` — Atlas orchestrator (→ Hou Tu 后土)

- Source: https://github.com/code-yeongyu/oh-my-openagent — commit `830ec1e294afa9823bd193b931c39cd67897c30f` (2026-07-14)
- Upstream path: `packages/prompts-core/prompts/atlas/`

| File | Upstream |
|------|----------|
| `atlas/default.md` | `packages/prompts-core/prompts/atlas/default.md` |
| `atlas/gpt.md` | `packages/prompts-core/prompts/atlas/gpt.md` |
| `atlas/gemini.md` | `packages/prompts-core/prompts/atlas/gemini.md` |

### `prometheus/` — Prometheus planner (→ Fu Xi 伏羲)

- Source: https://github.com/code-yeongyu/oh-my-openagent — commit `830ec1e294afa9823bd193b931c39cd67897c30f` (2026-07-14)
- Upstream path: `packages/prompts-core/prompts/prometheus/`

| File | Upstream |
|------|----------|
| `prometheus/default.md` | `packages/prompts-core/prompts/prometheus/default.md` |

### `ulw-plan/` — ultrawork planner skill baseline

- Source: https://github.com/code-yeongyu/oh-my-openagent — commit `830ec1e294afa9823bd193b931c39cd67897c30f` (2026-07-14)
- Upstream path: `packages/shared-skills/skills/ulw-plan/`
- License: SUL-1.0 (`LICENSE.md` at the same commit)
- Note: this directory is an inactive byte-identical reference baseline. The modified Pi runtime adaptation lives at `modes/fuxi/skills/ulw-plan/` and carries the upstream license and modification notice.

| File | Upstream |
|------|----------|
| `ulw-plan/SKILL.md` | `packages/shared-skills/skills/ulw-plan/SKILL.md` |
| `ulw-plan/agents/openai.yaml` | `packages/shared-skills/skills/ulw-plan/agents/openai.yaml` |
| `ulw-plan/references/full-workflow.md` | `packages/shared-skills/skills/ulw-plan/references/full-workflow.md` |
| `ulw-plan/references/intent-clear.md` | `packages/shared-skills/skills/ulw-plan/references/intent-clear.md` |
| `ulw-plan/references/intent-unclear.md` | `packages/shared-skills/skills/ulw-plan/references/intent-unclear.md` |
| `ulw-plan/scripts/scaffold-plan.mjs` | `packages/shared-skills/skills/ulw-plan/scripts/scaffold-plan.mjs` |

_(Add a section here for each new persona you vendor.)_
