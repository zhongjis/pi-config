# Agent Orchestration Across Modes

High-level map of how the three agent **modes** get work done by delegating to
**subagents**. This is an overview — it links to the authoritative detail rather
than restating it.

Where the details live:

| Topic | Source of truth |
|-------|-----------------|
| Workflow lifecycles and how-to | [`docs/guides/orchistration.md`](orchistration.md) |
| Delegation authorization internals | [`docs/specs/mode-scoped-subagent-delegation.md`](../specs/mode-scoped-subagent-delegation.md) |
| Mode switching, plan approval, restrictions | [`docs/specs/modes.md`](../specs/modes.md) · [`extensions/modes/README.md`](../../extensions/modes/README.md) |
| `Agent` tool API (spawn / resume / supervise) | [`extensions/subagents/README.md`](../../extensions/subagents/README.md) |
| Frontmatter fields (`allow_delegation_to`, `prompt_mode`, …) | [`docs/guides/agent-frontmatter.md`](agent-frontmatter.md) |

---

## Two orchestration philosophies

| Workflow | Modes | Shape |
|----------|-------|-------|
| **Single-session** | Kua Fu | Classify the request, delegate specialists, verify, respond — all in the current session. |
| **Plan-then-execute** | Fu Xi → Hou Tu | Fu Xi plans; on approval a **child session** opens in Hou Tu to execute. |

All modes delegate through the same `Agent` tool. What differs per mode is *which*
subagents it may call, *how* it routes, and *when* it hands off.

---

## Modes at a glance

| Mode | Alias | Orchestration role |
|------|-------|--------------------|
| **Kua Fu 夸父** | `build` | Default build orchestrator. Intent-gates the request, routes bounded work to specialists, verifies. Uses `xuannv` for tactical planning. |
| **Fu Xi 伏羲** | `plan` | Planner. Interview → draft → approved brief → `PLAN.md` → Di Renjie gap review → plan approval → Hou Tu handoff. Writes only `PLAN.md`/`DRAFT.md`; does not implement. |
| **Hou Tu 后土** | `execute` | Execution conductor. Runs an approved plan as a pi-task DAG, delegating every task; verifies through a final gate wave. Writes no code directly. |

Details of each mode's lifecycle, restrictions, and gates are in
[`orchistration.md`](orchistration.md) and
[`modes.md`](../specs/modes.md).

---

## Subagent roster (delegation targets)

Orchestrators route to these leaf specialists. Only `xuannv` can itself delegate
(to read-only recon/research/analysis agents); implementation and writing workers are leaves.

| Agent | Role | Writes code? | Can delegate? |
|-------|------|:---:|:---:|
| `chengfeng` | Codebase recon / tracing | no | no |
| `wenchang` | External docs / web research | no | no |
| `cangjie` | Standalone human-facing documentation / technical prose | no | no |
| `taishang` | Architecture + debugging consult, plan-compliance | no | no |
| `direnjie` | Gap analysis (assumptions, guardrails, scope) | no | no |
| `yanluo` | High-accuracy finalized-plan review | no | no |
| `xuannv` | Tactical planning advisor (returns plan text) | no | **yes** |
| `guangguang` | Quick, deterministic, naturally single-file implementation | yes | no |
| `jintong` | Clear, standard-risk, low-to-moderate non-UI implementation | yes | no |
| `juling` | Substantial cross-module or elevated-reasoning non-UI implementation | yes | no |
| `yunu` | Frontend/web visual-engineering implementation; orchestrator owns visual/browser QA | yes | no |

Roles and tool posture are defined in each `agents/<name>.md`; see
[agent-frontmatter.md](agent-frontmatter.md).

---

## Delegation matrix

Which subagent each mode may delegate to. **Authoritative source is each mode's
`allow_delegation_to` / `disallow_delegation_to` frontmatter** (`modes/<mode>/mode.md`);
this table is a convenience snapshot.

| Target ↓ / Mode → | kuafu | fuxi | houtu |
|---|:---:|:---:|:---:|
| chengfeng | ✓ | ✓ | ✓ |
| wenchang | ✓ | ✓ | ✓ |
| cangjie | ✓ | — | ✓ |
| taishang | ✓ | ✓ | ✓ |
| direnjie | ✓ | ✓ | ✓ |
| yanluo | — | ✓ | — |
| xuannv | ✓ | — | — |
| jintong | ✓ | — | ✓ |
| juling | ✓ | — | ✓ |
| guangguang | ✓ | — | ✓ |
| yunu | ✓ | ✓ | ✓ |
| houtu | ✗ | ✗ | — |

Notes: `fuxi` excludes `cangjie`; Fu Xi owns plan prose and allows `yunu` only
for UI feasibility input, not general implementation. `yanluo` is fuxi-only and
`xuannv` is kuafu-only. **Hou Tu is never a delegation target** — it is reached
through the approval → `/handoff:start-work` bridge, not by delegation.

Delegation is **mode-scoped and fail-closed**: the allowlist sets candidates, the
blocklist removes them, and any target outside the resolved set is denied at every
spawn ingress (a denial reports the permitted targets). Full model:
[mode-scoped-subagent-delegation.md](../specs/mode-scoped-subagent-delegation.md).

---

## Cross-mode transitions

| Transition | Trigger | Mechanism |
|------------|---------|-----------|
| Fu Xi → Hou Tu | plan approved | `plan_approve` → `/handoff:start-work` opens a child session seeded `agent-mode: houtu`. |
| Kua Fu → Fu Xi | plan-first work | User switches with `/mode fuxi`. Kua Fu does **not** spawn Fu Xi as a subagent. |
| Any → any | manual | `/mode <name>`, `/mode:<name> <text>`, `Ctrl+Shift+M` cycle, or `--mode` at startup. |

`fuxi` and `houtu` are **modes, not spawnable subagents** — moving between them is a
mode switch (or the approval bridge), never an `Agent` call. See
[modes.md](../specs/modes.md) for switching details.

---

## Verification

Every mode owns verification: the delegating mode reads changed files and runs
diagnostics/tests/build itself — a subagent's self-report is never sufficient.
Code-quality review is **orchestrator-owned** in every mode; `taishang` is
architecture/debugging/plan-compliance only, never a code-quality reviewer. Hou Tu's
per-task and final-gate verification is detailed in
[orchistration.md](orchistration.md).
