# Panda Harness

One user's opinionated [Pi](https://github.com/mariozechner/pi-coding-agent) configuration. Bundles Mode Agents, Subagents, Extensions, and a Nix-managed dev environment into one personal harness — not a shared framework.

## Core

**Panda Harness**:
The whole personal setup: the Pi runtime, every configuration in this repo, and the externally managed Skills at `~/.pi/agent/skills`.
_Avoid_: framework, template

**Pi**:
The underlying coding-agent runtime this repo configures.

**Agent**:
Umbrella term for the two persona kinds defined here — a Mode Agent or a Subagent. Never used to mean the Pi runtime itself.

**Mode Agent**:
A persona under `modes/` that swaps the main agent's prompt and tool access for the duration of a session.
_Avoid_: mode (when a persona is meant), persona

**Subagent**:
A delegate persona under `agents/`, invoked by an orchestrator through the `Agent` tool to do one bounded task.
_Avoid_: helper, worker

## Capability sources

**Skill**:
A specialized instruction set (`SKILL.md`) loaded on demand. Lives externally at `~/.pi/agent/skills`, not in this repo.

**Extension**:
A local runtime capability living under `extensions/`, editable in-repo. See https://pi.dev/docs/latest/extensions.
_Avoid_: plugin

**Package**:
A Pi package installed from an external source (git or npm), immutable in use. See https://pi.dev/docs/latest/packages.
_Avoid_: plugin, module

**Git package**:
A Package sourced from a git remote and used as-is; the repo never edits it.

**Vendored extension**:
An Extension that began as a hard fork of an upstream git Package, kept local because the user needs to customize it.

## Extension layout tiers

Ordered stages an Extension grows through; never skip ahead.

**Flat**:
Tier 1 — `extensions/foo/index.ts` plus siblings.

**Structured**:
Tier 2 — `index.ts` plus `src/` and `test/`.

**Package tier**:
Tier 3 — re-export-only `index.ts`, implementation under `src/`, with a `package.json`. Distinct from a Pi **Package**; this names an Extension's internal layout only.

## Documentation buckets

**Idea**:
A speculative, non-binding note under `docs/ideas/`; every such document carries `Status: idea`.

**Spec**:
A Panda Harness contract under `docs/specs/`, whether shipped, planned, or draft.

**Decision**:
An append-only ADR under `docs/adr/` — one decision per document, recording why X was chosen over Y.
_Avoid_: ADR (in prose), rationale doc

**Reference**:
Stable, citable external material under `docs/references/`.

## Mode Agents

Five personas, each with its own mythology name.

**Kua Fu 夸父**:
Build mode — the default general-purpose implementation orchestrator.

**Fu Xi 伏羲**:
Plan mode — plan drafting with restricted tools.

**Hou Tu 后土**:
Execute mode — plan execution after handoff.

**Lu Ban 鲁班**:
Skill-first discipline mode, adapted from obra/superpowers.

**Shennong 神農**:
Product-manager mode, backed by the PM skill pack.

## Subagents

Code quality uses an **orchestrator-owned code-quality gate**: no dedicated code-quality persona exists; orchestrators run checks and review diffs against requirements.

**Chengfeng 乘风**:
Codebase discovery, tracing, and pattern finding.

**Wenchang 文昌**:
Docs, web, and external-library research.

**Jintong 金童**:
Standard bounded non-UI implementation, debug, and test (sonnet tier).

**Juling 巨灵**:
Complex or higher-risk non-UI implementation (opus tier).

**Yunu 玉女**:
Frontend and web-UI implementation plus visual QA.

**Guangguang 光光**:
Trivial single-file edits, typos, and obvious config nits.

**Taishang 太上**:
Read-only architecture/debugging consult and plan-compliance audit only; does not do code-quality review.

**Cangjie 仓颉**:
Single-file Markdown or self-contained static-HTML draft/rewrite from provided context.

**Yan Luo 阎罗**:
Final high-accuracy plan reviewer used in Plan mode (Momus-style).

**Di Renjie 狄仁杰**:
Plan gap analyzer used in Plan mode — catches hidden assumptions and execution risks (Metis-style).
