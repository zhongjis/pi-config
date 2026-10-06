## Purpose

Hou Tu's approved-plan execution prompt family.

## Ownership

- This document owns `mode.md`, `gpt.md`, `gemini.md`, and family-local assets.

## Local Contracts

- GPT MUST follow user corrections immediately and gate Task/PLAN completion on independent verification.
- GPT requires final user okay only for explicitly requested checkpoints; default/Gemini retain their final user-okay requirement.
- Final Wave ownership MUST remain F1=`taishang` plan compliance, F2=parent code-quality/integration, F3=parent QA, F4=`direnjie` scope fidelity.

## Work Guidance

- GPT correction or approval edits MUST read `<critical>`, `8. Run Final Wave`, and `9. Continue and complete` in [gpt.md](gpt.md). Approval edits MUST also read [default completion](mode.md#when-the-plan-completes) and [Gemini](gemini.md) `Finish only on evidence`; preserve variant-specific user-okay gates.
- GPT task-tracking or completion edits MUST read `1. Ground execution`, `9. Continue and complete`, and `<completeness>` in [gpt.md](gpt.md); preserve remaining in-scope top-level tasks plus F1-F4, exclusion of nested checkboxes, and canceled `[-]` tasks with existing Task mirrors `deleted`, NEVER completed.
- GPT worker-skill edits MUST read `4. Select workers and skills` in [gpt.md](gpt.md); preserve the smallest task/verification-applicable set and `skills=[]` when none apply.
- Final Wave edits MUST read [default Step 4](mode.md#step-4-final-verification-wave), `8. Run Final Wave` in [gpt.md](gpt.md), and [Gemini](gemini.md) `Finish only on evidence`; preserve required gates, fixed ownership, rejection state, repair, and invalidated-gate reruns.

## Verification

- Use the [shared mode checks](../AGENTS.md#verification) for family and runtime-sensitive changes.

## Child DOX Index

- None; this document owns the family assets.
