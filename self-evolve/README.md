# self-evolve extractor + dashboard

This module stays self-contained under `self-evolve/`. It currently ships two operator-facing workflows:
- `extract` — parse one Pi parent session JSONL into deterministic JSON exports plus SQLite cache rows
- `dashboard` — render one static HTML dashboard from persisted Module 1 JSON exports only

> Module 2 does **not** reread raw JSONL. Dashboard generation reads only the durable JSON exports already written by `extract` under `--input-root`.

## Scope

Current scope:
- parse one parent session JSONL
- preserve normalized events, warnings, metrics, joined tool activity, and linked subagent summaries
- enrich subagents from referenced sidechain `.output` files when those files still exist
- write one durable JSON export per `session_id`
- mirror the same extracted session into SQLite for local querying and reruns
- render a same-page static HTML dashboard flow: Session List → Session Detail → Baseline Comparison

Runtime layout facts in this module come from the sampled schema notes in `docs/session-log-schema-notes.md`. In particular, parent sessions were observed under `~/.pi/agent/sessions/<cwd-encoded-dir>/<session>.jsonl`, and sidechain transcript hints were observed under `/tmp/pi-subagents-*/.../*.output`; treat those path patterns as observed runtime evidence, not a durability guarantee.

## Environment entry

From the repo root:

```bash
cd self-evolve
nix flake check path:$PWD
nix develop path:$PWD
```

`self-evolve/.envrc` uses `use flake path:$PWD`, so direnv entry is also module-local:

```bash
cd /home/zshen/personal/pi-config/self-evolve
direnv allow "$PWD"
```

The root repo shell and root docs stay unchanged.

## Test and smoke commands

Run commands from `self-evolve/`:

```bash
nix develop path:$PWD -c pytest
nix develop path:$PWD -c pytest tests/test_parser.py
nix develop path:$PWD -c pytest tests/test_cli_smoke.py
nix develop path:$PWD -c python -m self_evolve.extractor.cli --help
nix develop path:$PWD -c python -m self_evolve.extractor.cli dashboard --help
```

## Current CLI surface

Run commands from `self-evolve/`.

### `extract`

```bash
nix develop path:$PWD -c \
  python -m self_evolve.extractor.cli extract SESSION_PATH \
  [--output-root OUTPUT_ROOT] \
  [--sqlite-path SQLITE_PATH]
```

Example clean extract:

```bash
nix develop path:$PWD -c \
  python -m self_evolve.extractor.cli extract tests/fixtures/parent-clean.sample.jsonl
```

Example explicit output locations:

```bash
nix develop path:$PWD -c \
  python -m self_evolve.extractor.cli extract tests/fixtures/parent-clean.sample.jsonl \
  --output-root "$PWD/.tmp/self-evolve" \
  --sqlite-path "$PWD/.tmp/self-evolve/custom.sqlite3"
```

### `dashboard`

```bash
nix develop path:$PWD -c \
  python -m self_evolve.extractor.cli dashboard \
  [--input-root INPUT_ROOT] \
  [--output-path OUTPUT_PATH] \
  [--baseline-session-id SESSION_ID] \
  [--open]
```

Example default dashboard render from extracted JSON exports:

```bash
nix develop path:$PWD -c \
  python -m self_evolve.extractor.cli dashboard \
  --input-root "$PWD/.tmp/self-evolve"
```

Example explicit baseline choice for the comparison section:

```bash
nix develop path:$PWD -c \
  python -m self_evolve.extractor.cli dashboard \
  --input-root "$PWD/.tmp/self-evolve" \
  --baseline-session-id session-parent-clean
```

## Outputs and operator-facing behavior

### `extract`

Successful `extract` writes two persistence outputs:
- JSON export: `<output-root>/<session_id>.json`
- SQLite cache: `--sqlite-path` when provided, otherwise `<output-root>/self-evolve.sqlite3`

Path handling is current-code behavior:
- `session_path`, `output_root`, and `sqlite_path` are resolved to absolute paths before work starts
- `output_root` is created if missing
- the SQLite parent directory is created if missing
- when you run from `self-evolve/` without flags, the defaults resolve under `$PWD/.tmp/self-evolve/`

CLI streams:
- stdout: one JSON status object on success with `command`, `status`, `session_id`, `session_path`, `export_path`, `sqlite_path`, `events`, `tool_calls`, `subagents`, and `warnings`
- stderr: warning lines for non-fatal extractor warnings, formatted as `warning: [<warning_code>] <scope> ...`
- stderr: `error: ...` line for failures

Exit codes:
- `0` — extraction and persistence completed, even if warnings were emitted on stderr
- `2` — input `session_path` did not exist
- `1` — other extraction or persistence failure

### `dashboard`

`dashboard` reads only persisted Module 1 JSON exports from `--input-root`. It does **not** parse raw JSONL files, and it does not depend on SQLite.

Default input/output behavior:
- `--input-root` defaults to `$PWD/.tmp/self-evolve`
- the command loads all `*.json` exports directly under `--input-root`
- default HTML output path is `<input-root>/dashboard/index.html`
- static assets are copied into `<output-path parent>/static/`
- `--output-path` overrides the HTML file location; the static asset directory follows that file's parent directory
- `--open` writes the HTML first, then asks the local browser to open that generated file

Baseline-selection behavior:
- selected session = the same focused session shown in Session Detail
- baseline session is **never auto-selected**
- `--baseline-session-id SESSION_ID` explicitly chooses one comparison target from the available persisted exports
- when `--baseline-session-id` is omitted, Baseline Comparison stays in a disabled `Baseline not selected` state and shows the explicit rerender path
- when `--baseline-session-id` is invalid for the current focused session, comparison stays disabled and reports that invalid selection clearly

Dashboard flow and fallbacks:
- operator flow is `Session List → Session Detail → Baseline Comparison` in one static HTML page
- Session Detail follows the first row in the current triage order from Session List
- missing optional values render as `Not recorded`; the dashboard never invents zeroes or health claims
- percentage deltas render only when both sides exist and the baseline value is non-zero
- comparison fit is cautious/inconclusive only from real available fields; no task-similarity certainty is claimed

## Re-extract and replacement semantics

Re-extract is keyed by the normalized `session_id`, not by the source filename.

Current replacement behavior:
- the durable JSON export path is always `<output-root>/<session_id>.json`, so rerunning the same `session_id` replaces that file
- SQLite upserts the `sessions` row for that `session_id`
- SQLite then deletes and reinserts all child rows for that `session_id` in `session_events`, `session_tool_calls`, `session_subagents`, `session_warnings`, and `session_metrics`
- stale child rows from an earlier extract for the same `session_id` do not survive
- the same `tool_call_id` may appear in different sessions because SQLite uses `(session_id, tool_call_id)` as the key

Operational consequence: renaming the source file alone does not create a new durable export if the session header still says the same `id`.

## Fixture strategy

Fixture policy is local and synthetic only:
- committed fixtures under `tests/fixtures/` are schema-shaped synthetic samples, not copied personal logs
- raw personal session logs do not belong in this module
- parser and CLI tests use those fixtures plus temporary output directories created by pytest fixtures
- the parser-level sidechain fixture uses an injected resolver in tests; the module does not rely on a durable real `/tmp` sidechain file being present across reruns

See `tests/fixtures/README.md` for the fixture inventory and `docs/session-log-schema-notes.md` for the schema-discovery basis behind the synthetic shapes.

## Known limitations

Current limits, based on code and sampled evidence:
- sidechain enrichment is opportunistic; parent extraction remains the durable source of truth when `/tmp/pi-subagents-*` files are gone
- sampled sidechain evidence only proves the short wrapper schema documented in `docs/session-log-schema-notes.md`; it does not prove rich multi-turn child transcripts in current samples
- the parser currently emits `present`, `missing`, `parse_warning`, and `not_referenced` sidechain states in practice; `unsupported` exists in the model enum but is not currently emitted by the parser
- warning-bearing parent logs are preserved as extracted sessions; malformed lines are warned and skipped, and truncated EOF marks the session incomplete
- dashboard `source` and `config_version` remain contract gaps because Module 1 does not durably emit them yet
- task similarity is unknown in the current contract, so Baseline Comparison caveats remain conservative by design
- Baseline Comparison uses only current durable fields such as project path, extraction health, and timestamp proximity; it does not infer same-source or same-config fit

## Troubleshooting

### Malformed or truncated parent logs

Symptoms:
- stderr warnings such as `malformed_json_line` or `truncated_final_line`
- exported `session.is_incomplete = true` for truncated EOF

What to check:
- inspect the `warnings` array in the JSON export
- inspect `session.line_counts` and `session.incomplete_reasons`
- expect exit code `0` if extraction still completed

### Missing sidechain transcripts

Symptoms:
- stderr warning `missing_sidechain_file`
- extracted subagent has `sidechain.status = "missing"`

What to check:
- the parent session may still contain the subagent summary and path hint
- this is non-fatal by design because `/tmp` sidechains are enrichment only
- rerunning after a sidechain becomes available replaces the prior `missing` status for the same `session_id`

### Reruns look stale

Symptoms:
- export file name did not change after switching input filenames
- old rows appear to survive between runs

What to check:
- verify the parent `session` header `id`; replacement keys come from `session_id`, not the source filename
- inspect the JSON export path and SQLite path reported on stdout
- if you intentionally want a separate extracted session, the source data must contain a different session header `id`

## Non-goals

This module does not currently own:
- any analyzer or recommendation UI
- any autoresearch pipeline or lineage model
- committed raw Pi session logs
- durable dependence on `/tmp` sidechain transcripts
- broad root-repo documentation changes outside `self-evolve/`

For the exact durable shapes, see `docs/data-contract.md`. For the test matrix and fixture helpers, see `docs/test-harness.md`.
