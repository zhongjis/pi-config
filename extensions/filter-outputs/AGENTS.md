## Purpose

Redact sensitive data from tool outputs before the model sees them.

## Ownership

- Owns redaction matching, tool-output rewriting, and tests.

## Local Contracts

- MUST redact credential stores as whole files while keeping credential-related source and test paths readable with normal value redaction; [owning code](index.ts) defines store matching.

## Work Guidance

## Verification

- `pnpm exec vitest run --project unit extensions/filter-outputs/test`

## Child DOX Index

- None.
