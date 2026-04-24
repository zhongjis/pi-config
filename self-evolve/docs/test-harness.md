# Module-local test harness and command surface

This test harness stays inside `self-evolve/`. Root `pnpm` and Vitest flows are out of scope.

## Canonical commands

Run from `self-evolve/`:

```bash
nix flake check path:$PWD
nix develop path:$PWD -c pytest
nix develop path:$PWD -c pytest tests/test_parser.py
nix develop path:$PWD -c pytest tests/test_cli_smoke.py
nix develop path:$PWD -c python -m self_evolve.extractor.cli --help
nix develop path:$PWD -c python -m self_evolve.extractor.cli extract tests/fixtures/parent-clean.sample.jsonl
```

Notes:
- `self-evolve/.envrc` uses `use flake path:$PWD`
- `pythonpath = ["src"]` is set in `pyproject.toml`, so pytest can import `self_evolve` inside the module shell
- the CLI smoke path is `python -m self_evolve.extractor.cli extract <session-path>`

## What the tests currently cover

### Parser coverage

`tests/test_parser.py` currently verifies:
- clean parent extraction
- malformed line + truncated EOF warning handling
- sidechain-present parsing through an injected `sidechain_path_resolver`
- missing sidechain behavior as a non-fatal warning with preserved path hint

### CLI and persistence coverage

`tests/test_cli_smoke.py` currently verifies:
- help output smoke
- missing input path returns exit code `2`
- clean extract returns exit code `0`, writes deterministic JSON, and persists SQLite rows
- warning-bearing extract still returns exit code `0` and prints warnings on stderr
- identical rerun produces byte-identical JSON output
- rerun for the same `session_id` replaces prior child rows instead of duplicating them
- legacy SQLite `session_tool_calls(tool_call_id PRIMARY KEY)` is migrated so `(session_id, tool_call_id)` works across sessions

### Package smoke

`tests/test_package_layout.py` verifies the package scaffold import docstring.

## Fixture strategy

Fixtures are synthetic on purpose.

Committed fixture files:
- `tests/fixtures/parent-clean.sample.jsonl`
- `tests/fixtures/parent-malformed-truncated.sample.jsonl`
- `tests/fixtures/parent-with-sidechain.sample.jsonl`
- `tests/fixtures/sidechain-present.sample.output`

Rules:
- no committed raw personal session logs
- no real session ids, prompts, or filesystem paths beyond synthetic schema placeholders
- no durable dependency on a real `/tmp/pi-subagents-*` file for test correctness

Schema provenance for these fixtures is recorded in `docs/session-log-schema-notes.md`.

## Pytest fixtures and helpers

`tests/conftest.py` exposes:
- `clean_parent_fixture`
- `malformed_parent_fixture`
- `sidechain_parent_fixture`
- `sidechain_output_fixture`
- `temp_output_root`
- `temp_sqlite_path`
- `clean_parent_records`
- `load_fixture_text(name)`

Use those helpers instead of hard-coding fixture paths in new local tests.

## Operator notes for local verification

### Clean extract

A normal clean run should produce:
- exit code `0`
- JSON status on stdout
- no stderr output for the clean fixture
- JSON export at `<output-root>/session-parent-clean.json`
- SQLite rows in the selected database path

### Warning-bearing extract

The malformed/truncated fixture should produce:
- exit code `0`
- warning lines on stderr
- JSON export warnings containing `malformed_json_line` and `truncated_final_line`
- SQLite warning rows for the same session

### Sidechain fixture nuance

`parent-with-sidechain.sample.jsonl` references a synthetic `/tmp/.../agent-side-1.output` path. Parser tests inject `sidechain_output_fixture` through `sidechain_path_resolver` to make that link present. The CLI does not inject a resolver, so a direct CLI run against that parent fixture will report `missing_sidechain_file` unless you create a matching file at the hinted path.

## Troubleshooting

### `session path not found`
- Confirm the input file exists.
- The CLI resolves the path before parsing and returns exit code `2` for this case.

### Warnings but successful exit
- This is expected for non-fatal malformed lines, truncated EOF, or missing sidechains.
- Check stderr plus the exported `warnings` array.

### Duplicate-looking reruns
- Replacement happens by extracted `session_id`, not by input filename.
- If you changed filenames but kept the same session header `id`, the run will overwrite the same JSON export and SQLite session rows.
