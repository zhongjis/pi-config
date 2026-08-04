# init

Slash-command extension for AGENTS.md/DOX initialization prompts. Registers `/init-deep` and `/init-dox`.

## Upstream / Provenance

- `/init-deep`: informed by upstream init-deep SUL concepts only; prompt wording is local/Pi-native, with no wholesale copy.
- `/init-dox`: uses the DOX docs/process layer from `agent0ai/dox` upstream `main` (MIT); DOX is not vendored as a Pi extension or package.

## Commands

- `/init-deep` — Generate hierarchical AGENTS.md files; update mode modifies existing docs and creates new child docs where warranted.
- `/init-deep --create-new` — Read existing docs, then remove/regenerate the AGENTS.md hierarchy.
- `/init-deep --max-depth=N` — Limit child-doc depth; template default is 3.
- `/init-dox` — Add or migrate AGENTS.md files to the DOX contract and child-index model.
- `/init-dox <path-or-scope>` — Limit DOX work to the requested path or scope.
- `/init-dox --broader-changes` — Permit package/config/toolchain changes only when the user explicitly asked.

## Behavior

- Both commands forward raw args inside a hidden follow-up prompt and trigger the next turn.
- Both commands notify only when UI is present; headless runs skip notifications.
- Root `index.ts` is a re-export shim to `src/index.ts`; prompt templates live in `src/*-template.ts`.

## Files Worth Reading

- `src/index.ts` — command registration and follow-up dispatch.
- `src/init-deep-template.ts` — preserved `/init-deep` prompt template.
- `src/init-dox-template.ts` — canonical `/init-dox` DOX prompt template.
- `test/init.test.ts` — command/template contract tests.
