# self-evolve

## Overview
Self-contained Python + Nix module for extracting Pi session data into durable JSON/SQLite outputs and rendering a static dashboard from those exports.

## Structure
```
self-evolve/
├── src/self_evolve/extractor/   # parser, metrics, persistence, CLI
├── src/self_evolve/dashboard/   # loaders, view models, rendering, output
├── tests/                       # parser, CLI smoke, dashboard edge cases
├── docs/                        # contract notes, dashboard/test docs
└── .tmp/                        # local generated outputs; not source
```

## Where to Look
| Task | Location | Notes |
|------|----------|-------|
| CLI entry / argument flow | `src/self_evolve/extractor/cli.py` | `extract` + dashboard registration |
| Parse parent session JSONL | `src/self_evolve/extractor/parser.py` | Parent session source of truth |
| Metrics + persistence | `src/self_evolve/extractor/metrics.py`, `persistence.py` | JSON export + SQLite writes |
| Dashboard view model logic | `src/self_evolve/dashboard/view_models.py` | Biggest concentration of product logic |
| HTML/static output | `src/self_evolve/dashboard/render.py`, `output.py` | Template + asset copy path |
| Fixture inventory | `tests/fixtures/README.md` | Synthetic-only policy |
| Contract docs | `README.md`, `docs/data-contract.md`, `docs/test-harness.md` | Keep code/docs aligned |

## Commands
Run from `self-evolve/`.

```bash
nix flake check path:$PWD
nix develop path:$PWD
nix develop path:$PWD -c pytest
nix develop path:$PWD -c pytest tests/test_parser.py
nix develop path:$PWD -c pytest tests/test_cli_smoke.py
nix develop path:$PWD -c python -m self_evolve.extractor.cli --help
nix develop path:$PWD -c python -m self_evolve.extractor.cli dashboard --help
```

## Always
- Use the module-local Nix shell; root `pnpm`/Vitest flows do not validate this subtree.
- Keep the contract split intact: `extract` reads raw session JSONL; `dashboard` reads only persisted JSON exports.
- Keep fixtures synthetic and schema-shaped; personal session logs do not belong here.
- Remember reruns replace by normalized `session_id`, not by input filename.
- Keep docs in `README.md` / `docs/*.md` aligned with current CLI/output behavior when changing contracts.

## Ask First
- Changing durable JSON fields, SQLite schema, or output-path conventions.
- Broadening this module into root-repo docs or tooling outside `self-evolve/`.
- Changing the dashboard's missing-data posture (`Not recorded`, disabled comparison states, cautious caveats).

## Never
- Never commit generated `.tmp/` exports, dashboard HTML, or SQLite files.
- Never commit raw personal session logs.
- Never make dashboard code reread raw JSONL directly; persisted exports are the Module 2 boundary.
- Never invent zeroes, `source`, or `config_version` when the contract does not provide them.
- Never make sidechain `/tmp/pi-subagents-*` files a durable dependency; they are enrichment only.

## Gotchas
- `src/self_evolve/dashboard/view_models.py` is the symbol hotspot; small UI/label changes can ripple through many tests.
- `pythonpath = ["src"]` is set in `pyproject.toml`; tests assume imports resolve through the module shell.
- Sidechain enrichment is opportunistic: missing `/tmp` files warn but should not fail extraction.
