# Substitution map

Apply these consistently when adapting upstream prose to Pi. A token on the left, left in place, is a bug — it names a runtime that does not exist here.

## Runtime token map (omo → Pi)

| Upstream token / concept | Pi substitute |
|--------------------------|---------------|
| `task(category=…, subagent_type=…, load_skills=…, run_in_background=…)` | `TaskExecute` (plan-task execution) / `TaskCreate` (registration) / `Agent()` (read-only recon) — pick by context |
| category + `load_skills` delegation model | fixed `agentType` routing (see personas below); no dynamic skill loading in the delegation call |
| `TodoWrite` tracking | pi-tasks via `TaskCreate` / `TaskUpdate` |
| `.omo/plans/<name>.md` | `local://PLAN.md` |
| `.omo/notepads/<name>/*.md` | `local://NOTEPAD.learnings.md` / `.decisions.md` / `.issues.md` / `.blockers.md` |
| `background_output(task_id="bg_…")` | `get_subagent_result` / `TaskOutput` |
| `background_cancel(…)` | no direct equivalent — never bulk-cancel agents whose output is uncollected |
| resume same session via `task_id` (`ses_…`) | NOT available on `TaskExecute`. Re-run fresh: re-open with `TaskUpdate(status:"pending")`, sharpen `description`, `TaskExecute` again. **Never `Agent(resume)`** for plan tasks (runtime-forced + contract-locked; this is not a fork) |
| `boulder.json` / `completeBoulder()` / boulder-complete nudge | drop — no Pi runtime. Replace any completion-summary section with a plain final summary |
| `interactive_bash` | `bash` with explicit `cwd` |
| `/playwright` browser QA | delegate UI/browser QA to `yunu` |
| `{CATEGORY_SECTION}` / `{AGENT_SECTION}` / template placeholders | concrete Pi routing block |

## Persona name map

Always rename upstream persona names to the Pi persona (except in a single sanctioned attribution line — see `constraints-and-forks.md`).

| Upstream | Pi |
|----------|-----|
| Atlas | Hou Tu 后土 |
| Prometheus | Fu Xi 伏羲 |
| Sisyphus | Kua Fu 夸父 |
| Sisyphus-Junior `quick` | Guang Guang 光光 |
| Sisyphus-Junior `unspecified-low` | Jin Tong 金童 |
| Sisyphus-Junior `unspecified-high` | Ju Ling 巨灵神 |
| Sisyphus-Junior `visual-engineering` | Yu Nu 玉女 |
| Oracle | Taishang 太上老君 |
| Metis | Di Renjie 狄仁杰 |
| Momus | Yanluo 阎罗 |
| explore | Chengfeng 乘风 |
| librarian | Wenchang 文昌 |

`agentType` routing quick reference: `jintong` (standard bounded non-UI impl/debug/test), `juling` (opus-tier complex/higher-risk non-UI impl), `yunu` (frontend/UI + browser QA), `guangguang` (tiny single-file edit), `taishang` (read-only architecture/review), `chengfeng` (recon, background `Agent()`), `wenchang` (doc/web research, background `Agent()`), `cangjie` (single-file Markdown/HTML report — out of omo scope but a valid route).

## Family matrix

Each mode ships three variants; agents ship one file; ulw ships two. Keep variants aligned in intent.

| File | Role |
|------|------|
| `mode.md` | Canonical: YAML frontmatter + default (Claude-family) body. Owns the frontmatter the other variants inherit. |
| `gpt.md` | Body-only, **self-contained** replacement (inherits `mode.md` frontmatter). Principle-driven; must not start with `---`. |
| `gemini.md` | Body-only **corrective overlay** injected into the default body. Short, forceful overrides only. |
| `agents/<name>.md` | Single file: frontmatter (incl. `model:` family fallback list) + body. |
| `extensions/ulw/prompts/{default,gpt}.md` | ulw default + GPT variant. |

## Gemini-overlay injection anchor (critical)

`extensions/modes/src/hooks.ts` → `injectOverlays(body, overlays)`:
1. inject **before the first `<critical>`** (primary anchor — the "lost-in-the-middle" fix, hits peak attention),
2. else inject **after `</role>`**,
3. else append at end (degraded — overlay ends up at the bottom).

Consequence: the default body (`mode.md`) MUST keep an early `<critical>` (or at least `</role>`) anchor. Pure upstream tags (`<identity>`, `<mission>`, `<critical_overrides>`) do NOT match `indexOf("<critical>")` — so if you rename the wrappers to upstream tags, the corrective overlay silently falls to the bottom. Keep `<role>` + an early `<critical>` in adapted mode bodies. `test/fuxi-clearance.test.ts` mirrors this injector and asserts overlay-before-`<critical>` positioning.

## Default / GPT / Gemini philosophy

From `modes/MANIFESTO.md` (models are developers — match the prompt style to the family):
- **Default** (Claude-like: Opus/Sonnet, Kimi, GLM, Qwen): mechanics-driven — rigid protocols, explicit constraints, sequenced steps, XML structure.
- **GPT** (gpt-5.x, gpt-4o): principle-driven — high-level objectives, decision frameworks, minimal XML; dense instructions add noise.
- **Gemini**: corrective overlays — short precise overrides at structural anchor points, fixing three known regressions: information burial, tool neglect, premature termination.

Read `modes/MANIFESTO.md` for the full theory and the mode→model mapping table before rewriting a variant.
