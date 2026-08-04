# init

## Overview

Slash-command extension for AGENTS.md/DOX initialization prompts. `/init-deep` remains preserved; `/init-dox` owns the canonical DOX action prompt.

## Provenance

- `/init-deep`: upstream init-deep SUL concepts informed prompt shape only; wording is original, Pi-native, and never a wholesale copy.
- `/init-dox`: DOX source is `agent0ai/dox` upstream `main` (MIT), adopted as docs/process layer only, not a Pi extension/package.

## Structure

```
extensions/init/
├── index.ts                  # re-export shim
├── src/index.ts              # command registration
├── src/init-deep-template.ts # preserved /init-deep prompt
├── src/init-dox-template.ts  # canonical /init-dox DOX prompt
├── test/init.test.ts         # focused command/template contract tests
├── AGENTS.md
└── README.md
```

## Local Contracts

- Register exactly `/init-deep` and `/init-dox` from `src/index.ts` unless a later plan item changes the command surface.
- Keep root `index.ts` as `export { default } from "./src/index.js";`.
- Keep long prompts in `src/*-template.ts`; do not inline them into command registration.
- Preserve `/init-deep` behavior and raw-arg semantics.
- Keep README concise (~120 lines max) and update it with any command-surface change.

## Verification

```bash
pnpm test:extensions -- extensions/init/test/init.test.ts
pnpm lint:typecheck
# Stale-path scan for the old init directory name must return no matches.
test -f extensions/init/README.md && test -f extensions/init/AGENTS.md
```

## Never

- Do not add package/config/toolchain files in this extension.
- Do not nest deeper than `src/` or `test/`.
- Do not copy large upstream SUL prompt text wholesale.

## Child DOX Index

No child `AGENTS.md` files. This file owns all files under `extensions/init/`.
