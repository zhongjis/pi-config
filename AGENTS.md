# Global Agent Rules

## Core Principles

- Be direct. No filler, no preamble, no restating the question.
- Do the simplest thing that works. No premature abstractions, no over-engineering.
- Prefer readability over cleverness. Write code a tired person can understand.
- If something is unclear, ask before guessing. Wrong assumptions waste more time than a question.

## Code Quality

- No `any` types in TypeScript unless absolutely necessary — and leave a comment explaining why.
- Check `node_modules` for external API type definitions instead of guessing signatures.
- Never remove or downgrade working code to fix type errors — upgrade the dependency instead.
- Always ask before removing functionality or code that appears intentional.
- Prefer standard library and built-in solutions over adding dependencies.
- Keep functions short. If it needs a scroll, it needs a split.
- Name things for what they do, not what they are. `fetchUserOrders()` not `getData()`.

## Changes & Commits

- Make minimal, focused changes. Don't refactor unrelated code in the same change.
- Never commit unless explicitly asked.
- Run linters/type-checks after code changes (not docs) before considering work done.
- If you create or modify a test, run it and iterate until it passes.

## File Operations

- Read before writing. Understand existing code before modifying it.
- Prefer `edit` over `write` for existing files — surgical changes, not full rewrites.
- Never overwrite files without understanding their current content.

## Shell & Commands

- Never run destructive commands (`rm -rf`, `drop table`, `force push`) without explicit confirmation.
- Prefer short, composable commands over long pipelines.
- Always check exit codes — don't assume success.

## Problem Solving

- Start by understanding the problem. Read error messages carefully and fully.
- When debugging, form a hypothesis before making changes. Don't shotgun-fix.
- If a fix doesn't work after 2 attempts, step back and reconsider the approach.
- Explain your reasoning when the solution isn't obvious.

## Communication

- When presenting options, give a clear recommendation with reasoning.
- If a task is ambiguous, propose a concrete plan and ask for confirmation.
- Don't explain things I didn't ask about. Stay on task.
