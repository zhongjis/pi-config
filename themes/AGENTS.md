# themes

## Purpose

Theme JSON assets for local Pi UI presentation.

## Ownership

This file owns `themes/`.

## Local Contracts

- Keep theme files valid JSON.
- Do not rename or remove a theme file without updating any install/runtime reference that expects it.
- Treat visual token changes as user-facing behavior.

## Work Guidance

- Make the smallest token change that achieves the requested visual effect.
- Preserve existing naming style and JSON formatting.

## Verification

- Parse changed JSON with a JSON parser.
- If a visual change matters, inspect the affected UI manually in Pi when practical.

## Child DOX Index

No child `AGENTS.md` files. This file owns all files under `themes/`.
