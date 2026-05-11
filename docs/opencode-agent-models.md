# OpenCode Agent Model Mapping

Maps each custom agent in [`agents/`](../agents/) to its preferred model on the **OpenCode profile** (`opencode-go` + `opencode` providers).

This document is canonical for the `opencode` profile. For the `default` (US Anthropic/OpenAI) and `local` (llama-swap) profiles, see each agent's frontmatter.

---

## Context

- **OpenCode Go** = $10/mo curated bundle of 12 Chinese open-source coding models. Env var: `OPENCODE_API_KEY`.
- **OpenCode Zen** = pay-as-you-go tier (same key). Enable the `Use balance` toggle in [opencode.ai/auth](https://opencode.ai/auth) console; Go falls back to Zen balance automatically when quotas exhaust ([docs](https://opencode.ai/docs/go#usage-beyond-limits)).
- **Profile extension** (`extensions/profiles/`) filters `registry.getAvailable()` to the provider allowlist for the active profile. Comma-separated model chains in agent frontmatter are resolved first-available-wins within the allowlist.

---

## Quota reality check

OpenCode Go requests-per-month (April 2026 data):

| Model | req/5h | req/week | req/month |
|---|---:|---:|---:|
| GLM-5.1 | 880 | 2,150 | **4,300** |
| GLM-5 | 1,150 | 2,880 | **5,750** |
| Kimi K2.6 | 1,150 | 2,880 | **5,750** |
| MiMo-V2.5-Pro | 1,290 | 3,225 | **6,450** |
| Kimi K2.5 | 1,850 | 4,630 | **9,250** |
| MiMo-V2.5 | 2,150 | 5,450 | **10,900** |
| Qwen3.6 Plus | 3,300 | 8,200 | **16,300** |
| MiniMax M2.7 | 3,400 | 8,500 | **17,000** |
| DeepSeek V4 Pro | 3,450 | 8,550 | **17,150** |
| MiniMax M2.5 | 6,300 | 15,900 | **31,800** |
| Qwen3.5 Plus | 10,200 | 25,200 | **50,500** |

**Design implication:** Agents that fire often (chengfeng, wenchang, guangguang, houtu, kuafu) must be routed to the high-quota pools (Qwen3.5+ 50,500, M2.5 31,800). Agents that fire per-session (reviewers, planners) can share the scarce high-capability pools (GLM-5.1, Kimi K2.6, MiMo-V2.5-Pro).

---

## Capability tiers

**Top-tier (agentic engineering, reasoning):**
- `glm-5.1` — SOTA SWE-Bench Pro + NL2Repo + Terminal-Bench 2.0. Code-writer specialist.
- `glm-5` — "long-horizon complex systems" (Zhipu's own positioning). Planner specialist.
- `kimi-k2.6` — #1 open-weight on AA Intelligence Index (54). 256K ctx, native multimodal, agent swarm to 300 sub-agents.
- `deepseek-v4-pro` — #2 open-weight (52). 1M ctx. SWE-bench 80.6%, LiveCodeBench 93.5%.
- `mimo-v2.5-pro` — 1M ctx. Only model with documented 1000+ tool-call autonomous runs (11.5hr). Matches Opus 4.6.
- `minimax-m2.7` — Native Agent Teams (multi-agent coordination primitive). SWE-Pro 56.22%.

**Mid-tier (fast workhorses):**
- `minimax-m2.5` — SWE-Bench Verified 80.2% (SOTA at release). 100 TPS. Architect-style spec-writing.
- `qwen3.6-plus` — Terminal-Bench 61.6, SWE 78.8. Multimodal agentic coding.
- `mimo-v2.5` — 1M ctx, explicit image/audio/video modalities. Half cost of Pro.
- `deepseek-v4-flash` — Sonnet 4.6-tier intelligence, cheapest ($0.14/$0.28).
- `kimi-k2.5` — Vision-native, agent swarm (100 agents).

**Bulk tier:**
- `qwen3.5-plus` — 50,500 req/mo (5× nearest). General coding. Strong function-calling.

---

## Per-agent assignment

| Agent | Role | Primary | Secondary | Rationale |
|---|---|---|---|---|
| **chengfeng** | Read-only codebase recon. Fired constantly in background. | `opencode-go/qwen3.5-plus` | `opencode-go/deepseek-v4-flash` | Volume quota (50,500) dominates. DS V4 Flash (Sonnet 4.6-tier) as reliable fallback for tool-calling. |
| **wenchang** | External research, summarization. Fired often. | `opencode-go/qwen3.5-plus` | `opencode-go/minimax-m2.5` | Same quota reasoning. M2.5 as fast secondary. |
| **guangguang** | Trivial single-file edits (typo fixes). | `opencode-go/minimax-m2.5` | `opencode-go/qwen3.5-plus` | M2.5: 100 TPS + 31,800 quota + 80.2% SWE-Verified = perfect for trivial edits. |
| **jintong** | Bounded implementation + debug. Delegated by orchestrators. | `opencode-go/glm-5.1` | `opencode-go/mimo-v2.5-pro` | GLM-5.1 is SWE-Bench Pro SOTA = jintong's exact job. MiMo Pro for long-horizon fallback. |
| **taishang** | Architecture review, deepest reasoning. | `opencode-go/glm-5.1` | `opencode-go/deepseek-v4-pro` | Code review = code understanding. DS V4 Pro secondary for 1M context big reviews. |
| **direnjie** | Gap analysis, skeptical review. | `opencode-go/deepseek-v4-pro` | `opencode-go/glm-5` | #2 AA Intel + 17k quota. GLM-5 ("long-horizon reasoning") as secondary. |
| **yanluo** | High-accuracy plan validation. | `opencode-go/deepseek-v4-pro` | `opencode-go/glm-5.1` | Same reasoning as direnjie. |
| **weizheng** | Post-impl review, reads diff + runs checks. | `opencode-go/glm-5.1` | `opencode-go/deepseek-v4-pro` | GLM-5.1 SWE-Bench Pro SOTA = code-change review. |
| **fuxi** | Planning, decomposition, long-horizon. | `opencode-go/glm-5` | `opencode-go/glm-5.1` | GLM-5 is explicitly positioned for "long-horizon complex systems" by Zhipu. GLM-5.1 as code-aware fallback. |
| **houtu** | Plan-execution conductor. Delegates + verifies. | `opencode-go/minimax-m2.7` | `opencode-go/mimo-v2.5-pro` | M2.7 Agent Teams = literal conductor primitive, 17k quota. MiMo Pro's 1000+ tool-call runs = conductor essence. |
| **kuafu** | Default build orchestrator. Fires on every user message. | `opencode-go/minimax-m2.7` | `opencode-go/glm-5.1` | Can't share 4.3k GLM-5.1 pool as primary. M2.7 Agent Teams + 17k quota. |
| **luban** | Superpowers-disciplined orchestrator. Loads skills. | `opencode-go/kimi-k2.6` | `opencode-go/glm-5.1` | K2.6 256K ctx fits skill-loading volume. |
| **yunu** | UI/UX, visual/interaction focus. Needs vision. | `opencode-go/mimo-v2.5` | `opencode-go/kimi-k2.5` | MiMo-V2.5 explicit image/audio/video. K2.5 vision-native as secondary. |

---

## Frontmatter contract

Each agent's `model:` field is a comma-separated chain covering all three profiles. Order matters — first-available-wins within the filter set.

**Template:**
```
model: <default-primary>, <default-secondary>, opencode-go/<opencode-primary>, llama-swap/<local-primary>
```

**Example (chengfeng):**
```yaml
model: gpt-5.4-mini, claude-haiku-4-5, opencode-go/qwen3.5-plus, llama-swap/qwen2.5-coder:7b
```

Resolution per profile:
- `default` filter keeps `{anthropic, openai-codex}` → picks `gpt-5.4-mini` (first available)
- `opencode` filter keeps `{opencode, opencode-go}` → picks `opencode-go/qwen3.5-plus`
- `local` filter keeps `{llama-swap}` → picks `llama-swap/qwen2.5-coder:7b`

**Note:** Always use explicit `opencode-go/<id>` prefix. Bare `qwen3.5-plus` is ambiguous — both `opencode` and `opencode-go` providers register a model with that id, and `resolveModel`'s fuzzy match may hit the wrong one.

---

## Rate-limit overflow

Server-side. Enable `Use balance` in [opencode.ai/auth](https://opencode.ai/auth) console; OpenCode routes traffic to Zen balance automatically once Go quotas exhaust. No client-side wrapper.

Gap: 4 Go models have no Zen equivalent (`deepseek-v4-pro`, `deepseek-v4-flash`, `mimo-v2.5`, `mimo-v2.5-pro`) — quota errors for these surface to the user directly. Pi's built-in model fallback chain in agent frontmatter handles this: when the primary Go model errors, pi advances to the next entry in the comma-separated chain.

Effort suffix policy (clamping):
- **`deepseek-v4-pro`, `deepseek-v4-flash`** have `thinkingLevelMap = {minimal: null, low: null, medium: null, high: "high", xhigh: "max"}`. Only `:high` and `:xhigh` work; `:medium` clamps up.
- All other 10 Go models: default mapping, all pi levels pass through.

Recommended per-agent suffix:
- Reviewers, planners (taishang, direnjie, yanluo, fuxi, weizheng, jintong): `:high`
- Orchestrators (kuafu, houtu, luban): `:high` (or `:medium` for houtu to reduce quota burn)
- Trivial/recon (chengfeng, wenchang, guangguang): omit suffix

---

## Full frontmatter strings

Copy-paste ready. Add these as the `opencode-go/...` entry in each agent's `model:` chain.

| Agent | Chain entry |
|---|---|
| chengfeng | `opencode-go/qwen3.5-plus` |
| wenchang | `opencode-go/qwen3.5-plus` |
| guangguang | `opencode-go/minimax-m2.5` |
| jintong | `opencode-go/glm-5.1:high` |
| taishang | `opencode-go/glm-5.1:high` |
| direnjie | `opencode-go/deepseek-v4-pro:high` |
| yanluo | `opencode-go/deepseek-v4-pro:high` |
| weizheng | `opencode-go/glm-5.1:high` |
| fuxi | `opencode-go/glm-5:high` |
| houtu | `opencode-go/minimax-m2.7:medium` |
| kuafu | `opencode-go/minimax-m2.7:high` |
| luban | `opencode-go/kimi-k2.6:high` |
| yunu | `opencode-go/mimo-v2.5:high` |

---

## Data sources

- [OpenCode Go docs](https://opencode.ai/docs/go/) — model list, quotas, endpoints
- [GLM-5 release](https://z.ai/blog/glm-5) — benchmark positioning
- [Kimi K2.6 tech blog](https://www.kimi.com/blog/kimi-k2-6) — agent swarm specs
- [DeepSeek V4 release](https://api-docs.deepseek.com/news/news260424) — context window, benchmarks
- [MiniMax M2.7 blog](https://www.minimax.io/news/minimax-m27-en) — Agent Teams
- [MiMo-V2.5 / V2.5-Pro](https://mimo.xiaomi.com/mimo-v2-5-pro) — long-horizon tool-call records
- [Alibaba Qwen3.6 Plus](https://www.alibabacloud.com/blog/qwen3-6-plus-towards-real-world-agents_603005) — agentic coding benchmarks
- [ArtificialAnalysis open-weights leaderboard](https://artificialanalysis.ai/articles/deepseek-is-back-among-the-leading-open-weights-models-with-v4-pro-and-v4-flash) — cross-model intelligence index
