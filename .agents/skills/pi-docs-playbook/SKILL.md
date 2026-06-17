---
name: pi-docs-playbook
description: >-
  Source-grounded documentation navigator for the `earendil-works/pi` coding
  agent runtime. Use when designing, reviewing, or debugging an application
  built on top of pi — choosing SDK vs RPC vs CLI topology, writing pi
  extensions or tool wrappers, mapping pi sessions to application audit/event
  logs, reasoning about compaction/context/memory, approval/HITL surfaces,
  provider routing, or packaging skills/prompts. Triggers when the user asks how
  pi behaves, which pi docs to read, or wants to avoid guessing pi internals
  from memory. Mirrors upstream pi Markdown docs locally under `source/` so
  answers cite real files instead of hallucinated behavior. Not a pi tutorial
  and not a pi fork.
upstream: "https://github.com/enderzcx/pi-docs-playbook"
---

# pi-docs-playbook

A documentation harness for [`earendil-works/pi`](https://github.com/earendil-works/pi).

Your job is **not** to guess how pi works. Read the relevant mirrored upstream
docs under `source/`, then answer with source-grounded guidance.

All paths below are relative to this skill directory.

## Required Workflow

1. Read `usage/task-reading-matrix.md`.
2. Classify the user's question into one or more task categories from that matrix.
3. Read only the **required** `source/...` files listed for those categories.
4. Read **optional** files only when the question needs more detail.
5. Answer with explicit references to local `source/...` paths.

## Task Categories (see `usage/task-reading-matrix.md` for the file lists)

| Question is about… | Category |
|---|---|
| Embedded SDK vs RPC subprocess vs CLI | Runtime Topology |
| High-risk domain tools, approval gates, idempotency | Tool Wrapper Design |
| Mapping pi sessions to workflow records / replay | Session, Process, And Audit Mapping |
| What may enter model context, SQL rehydration | Context Builder And Memory Policy |
| Confirmation / operator review surfaces | Approval UX And Human In The Loop |
| Provider auth, model knobs, custom providers | Model And Provider Routing |
| Shipping reusable instructions or pi packages | Skills, Prompts, And Packaging |
| Terminal renderers, keybindings, themes | Terminal UX |
| Checking whether old conclusions are stale | Upstream Drift Check |

## Source Rules

- `source/` is the canonical mirrored upstream snapshot. Do not edit it unless explicitly refreshing the mirror.
- `catalog/` and `usage/` are local navigation aids.
- `skill-draft/` is a future-skill seed, **not** a finished specification — do not treat it as binding.
- Do not present undocumented behavior as a pi guarantee.
- If a claim may have drifted upstream, state the snapshot commit and recommend checking latest upstream.

## Answer Style

- Start with the shortest useful answer.
- Name the docs you read.
- Separate "pi provides" from "your application must design".
- Use local paths like `source/packages/coding-agent/docs/extensions.md`.
- Avoid copying long upstream passages.

## Common Boundaries

- pi session JSONL is agent trace, **not** your application's domain audit truth.
- pi extension hooks can shape tool calls and context, but your application still owns domain validation.
- pi compaction and branch summaries are summaries, **not** durable business facts.
- SDK is usually the first thing to inspect for in-process TypeScript integration.
- RPC is usually the first thing to inspect for subprocess or language-agnostic integration.
- TUI docs matter only when building terminal UI or custom renderers.

## Do Not

- Do not read every file by default.
- Do not invent an implementation plan before reading the matching docs.
- Do not treat `skill-draft/` as binding.
- Do not edit files under `source/` unless explicitly asked to refresh the mirrored snapshot.

## More

- `README.md` — full overview (bilingual) and recommended reading order.
- `PROMPT.md` — copy-paste prompt for handing this reference to a coding agent.
- `examples/` — concrete starter questions per task category.
