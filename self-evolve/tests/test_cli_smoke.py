from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

from self_evolve.extractor.cli import DEFAULT_SQLITE_NAME, prepare_extract_io


def test_prepare_extract_io_creates_temp_output_locations(
    clean_parent_fixture: Path,
    temp_output_root: Path,
    temp_sqlite_path: Path,
) -> None:
    prepared = prepare_extract_io(
        session_path=clean_parent_fixture,
        output_root=temp_output_root,
        sqlite_path=temp_sqlite_path,
    )

    assert prepared["session_path"] == str(clean_parent_fixture.resolve())
    assert prepared["output_root"] == str(temp_output_root.resolve())
    assert prepared["sqlite_path"] == str(temp_sqlite_path.resolve())
    assert temp_output_root.is_dir()
    assert temp_sqlite_path.parent.is_dir()


def test_prepare_extract_io_uses_default_sqlite_path(
    clean_parent_fixture: Path,
    temp_output_root: Path,
) -> None:
    prepared = prepare_extract_io(
        session_path=clean_parent_fixture,
        output_root=temp_output_root,
    )

    assert prepared["sqlite_path"] == str(temp_output_root.resolve() / DEFAULT_SQLITE_NAME)


def test_cli_extract_persists_json_and_sqlite(
    clean_parent_fixture: Path,
    temp_output_root: Path,
    temp_sqlite_path: Path,
) -> None:
    result = _run_extract(clean_parent_fixture, temp_output_root, temp_sqlite_path)

    assert result.returncode == 0
    assert result.stderr == ""

    export_path = temp_output_root / "session-parent-clean.json"
    payload = json.loads(result.stdout)
    assert payload == {
        "command": "extract",
        "status": "ok",
        "session_id": "session-parent-clean",
        "session_path": str(clean_parent_fixture.resolve()),
        "export_path": str(export_path.resolve()),
        "sqlite_path": str(temp_sqlite_path.resolve()),
        "events": 8,
        "tool_calls": 1,
        "subagents": 0,
        "warnings": 0,
    }

    exported = json.loads(export_path.read_text(encoding="utf-8"))
    assert exported["schema_version"] == 1
    assert exported["session"]["session_id"] == "session-parent-clean"
    assert exported["metrics"] == {
        "assistant_message_count": 2,
        "error_then_retry_count": 0,
        "session_duration_seconds": 3.0,
        "subagent_count": 0,
        "time_to_first_tool_call_seconds": 2.0,
        "tool_call_count": 1,
        "tool_error_count": 0,
        "tool_result_count": 1,
        "tool_success_rate": 1.0,
        "total_billed_tokens": 270,
        "total_cache_read_tokens": 0,
        "total_cache_write_tokens": 0,
        "total_cost": 0.0034,
        "total_input_tokens": 200,
        "total_output_tokens": 70,
        "unknown_record_count": 0,
        "user_message_count": 1,
        "warning_count": 0,
    }

    with sqlite3.connect(temp_sqlite_path) as connection:
        session_row = connection.execute(
            "SELECT session_id, raw_export_json FROM sessions"
        ).fetchone()
        assert session_row == (
            "session-parent-clean",
            export_path.read_text(encoding="utf-8"),
        )
        metrics_json = connection.execute(
            "SELECT metrics_json FROM session_metrics WHERE session_id = ?",
            ("session-parent-clean",),
        ).fetchone()
        assert metrics_json is not None
        assert json.loads(metrics_json[0]) == exported["metrics"]
        assert _table_counts(connection) == {
            "sessions": 1,
            "session_events": 8,
            "session_tool_calls": 1,
            "session_subagents": 0,
            "session_warnings": 0,
            "session_metrics": 1,
        }


def test_cli_help_smoke_command() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "self_evolve.extractor.cli", "--help"],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    assert "extract" in result.stdout
    assert "dashboard" in result.stdout



def test_cli_dashboard_writes_session_list_html(
    clean_parent_fixture: Path,
    malformed_parent_fixture: Path,
    temp_output_root: Path,
    temp_sqlite_path: Path,
) -> None:
    clean_result = _run_extract(clean_parent_fixture, temp_output_root, temp_sqlite_path)
    malformed_result = _run_extract(malformed_parent_fixture, temp_output_root, temp_sqlite_path)
    assert clean_result.returncode == 0
    assert malformed_result.returncode == 0

    output_path = temp_output_root / "dashboard" / "index.html"
    result = _run_dashboard(temp_output_root, output_path)

    assert result.returncode == 0
    assert result.stderr == ""

    payload = json.loads(result.stdout)
    assert payload == {
        "command": "dashboard",
        "status": "ok",
        "input_root": str(temp_output_root.resolve()),
        "output_path": str(output_path.resolve()),
        "static_dir": str((output_path.parent / "static").resolve()),
        "session_exports": 2,
        "static_assets": 1,
        "opened_browser": False,
    }

    html = output_path.read_text(encoding="utf-8")
    assert "Self-evolve session triage" in html
    assert "Triage Queue" in html
    assert "Session Table" in html
    assert "Timestamp" in html
    assert "Session ID" in html
    assert "Project / CWD" in html
    assert "Source" in html
    assert "Config Version" in html
    assert "Tool Success" in html
    assert "Error→Retry" in html
    assert "Unknown Records" in html
    assert "session-parent-clean" in html
    assert "session-parent-bad" in html
    assert "Contract gap" in html
    assert "--baseline-session-id session-parent-clean" in html
    assert "--baseline-session-id session-parent-bad" in html
    assert "Incomplete" in html
    assert "Extraction Weird" in html
    assert "Focused session" in html
    assert "Time to first tool call" in html
    assert "Token totals" in html
    assert "Tool reliability" in html
    assert "Extraction confidence" in html
    assert "Baseline Comparison" in html
    assert "Baseline not selected" in html
    assert "Explicit baseline choices" in html
    assert "Task 7" not in html
    assert (output_path.parent / "static" / "dashboard.css").is_file()


def test_cli_dashboard_empty_state(temp_output_root: Path) -> None:
    output_path = temp_output_root / "dashboard" / "index.html"
    result = _run_dashboard(temp_output_root, output_path)

    assert result.returncode == 0
    assert result.stderr == ""
    assert json.loads(result.stdout)["session_exports"] == 0

    html = output_path.read_text(encoding="utf-8")
    assert "No persisted session exports found" in html
    assert "Run extract first." in html
    assert "<table class=\"session-table\">" not in html
    assert "No focused session available" in html


def test_cli_dashboard_renders_selected_baseline_comparison(
    clean_parent_fixture: Path,
    malformed_parent_fixture: Path,
    temp_output_root: Path,
    temp_sqlite_path: Path,
) -> None:
    assert _run_extract(clean_parent_fixture, temp_output_root, temp_sqlite_path).returncode == 0
    assert _run_extract(malformed_parent_fixture, temp_output_root, temp_sqlite_path).returncode == 0

    output_path = temp_output_root / "dashboard" / "compare.html"
    result = _run_dashboard(
        temp_output_root,
        output_path,
        baseline_session_id="session-parent-clean",
    )

    assert result.returncode == 0
    html = output_path.read_text(encoding="utf-8")
    assert "Chosen baseline" in html
    assert "session-parent-clean" in html
    assert "session-parent-bad" in html
    assert "Duration" in html
    assert "Absolute delta" in html
    assert "Percent delta" in html
    assert "Task similarity unknown — metrics may not be directly comparable." in html

def test_cli_extract_missing_session_path_returns_error(temp_output_root: Path) -> None:
    missing_path = temp_output_root / "missing.jsonl"
    result = _run_extract(missing_path, temp_output_root)

    assert result.returncode == 2
    assert result.stdout == ""
    assert "error: session path not found:" in result.stderr


def test_cli_extract_warning_path_prints_warnings_and_persists_output(
    malformed_parent_fixture: Path,
    temp_output_root: Path,
    temp_sqlite_path: Path,
) -> None:
    result = _run_extract(malformed_parent_fixture, temp_output_root, temp_sqlite_path)

    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert payload["session_id"] == "session-parent-bad"
    assert payload["warnings"] == 2
    assert "warning: [malformed_json_line] parent_session line=3" in result.stderr
    assert "warning: [truncated_final_line] parent_session line=4" in result.stderr

    export_path = temp_output_root / "session-parent-bad.json"
    exported = json.loads(export_path.read_text(encoding="utf-8"))
    assert [warning["warning_code"] for warning in exported["warnings"]] == [
        "malformed_json_line",
        "truncated_final_line",
    ]

    with sqlite3.connect(temp_sqlite_path) as connection:
        assert _table_counts(connection) == {
            "sessions": 1,
            "session_events": 2,
            "session_tool_calls": 0,
            "session_subagents": 0,
            "session_warnings": 2,
            "session_metrics": 1,
        }


def test_cli_extract_is_deterministic_on_identical_rerun(
    clean_parent_fixture: Path,
    temp_output_root: Path,
    temp_sqlite_path: Path,
) -> None:
    first = _run_extract(clean_parent_fixture, temp_output_root, temp_sqlite_path)
    assert first.returncode == 0

    export_path = temp_output_root / "session-parent-clean.json"
    first_bytes = export_path.read_bytes()

    second = _run_extract(clean_parent_fixture, temp_output_root, temp_sqlite_path)
    assert second.returncode == 0
    second_bytes = export_path.read_bytes()

    assert json.loads(first.stdout) == json.loads(second.stdout)
    assert first_bytes == second_bytes

    with sqlite3.connect(temp_sqlite_path) as connection:
        assert _table_counts(connection) == {
            "sessions": 1,
            "session_events": 8,
            "session_tool_calls": 1,
            "session_subagents": 0,
            "session_warnings": 0,
            "session_metrics": 1,
        }


def test_cli_extract_replaces_existing_rows_for_same_session_id(
    clean_parent_fixture: Path,
    temp_output_root: Path,
    temp_sqlite_path: Path,
) -> None:
    rerun_source = temp_output_root / "rerun-source.jsonl"
    rerun_source.write_text(clean_parent_fixture.read_text(encoding="utf-8"), encoding="utf-8")

    first = _run_extract(rerun_source, temp_output_root, temp_sqlite_path)
    assert first.returncode == 0

    rerun_source.write_text(_replacement_fixture_text(), encoding="utf-8")
    second = _run_extract(rerun_source, temp_output_root, temp_sqlite_path)
    assert second.returncode == 0

    payload = json.loads(second.stdout)
    assert payload["session_id"] == "session-parent-clean"
    assert payload["events"] == 3
    assert payload["tool_calls"] == 0
    assert payload["warnings"] == 0

    export_path = temp_output_root / "session-parent-clean.json"
    exported = json.loads(export_path.read_text(encoding="utf-8"))
    assert len(exported["events"]) == 3
    assert exported["tool_calls"] == []

    with sqlite3.connect(temp_sqlite_path) as connection:
        assert _table_counts(connection) == {
            "sessions": 1,
            "session_events": 3,
            "session_tool_calls": 0,
            "session_subagents": 0,
            "session_warnings": 0,
            "session_metrics": 1,
        }
        stale_event = connection.execute(
            "SELECT event_id FROM session_events WHERE session_id = ? AND event_id = ?",
            ("session-parent-clean", "msg-tool-1"),
        ).fetchone()
        assert stale_event is None


def test_cli_extract_allows_same_tool_call_id_across_different_sessions(
    clean_parent_fixture: Path,
    temp_output_root: Path,
    temp_sqlite_path: Path,
) -> None:
    _create_legacy_tool_call_schema(temp_sqlite_path)

    first_source = temp_output_root / "session-one.jsonl"
    second_source = temp_output_root / "session-two.jsonl"
    fixture_text = clean_parent_fixture.read_text(encoding="utf-8")
    first_source.write_text(fixture_text, encoding="utf-8")
    second_source.write_text(
        _fixture_with_session_id(fixture_text, "session-parent-clean-2"),
        encoding="utf-8",
    )

    first = _run_extract(first_source, temp_output_root, temp_sqlite_path)
    second = _run_extract(second_source, temp_output_root, temp_sqlite_path)

    assert first.returncode == 0
    assert second.returncode == 0

    with sqlite3.connect(temp_sqlite_path) as connection:
        assert _table_counts(connection) == {
            "sessions": 2,
            "session_events": 16,
            "session_tool_calls": 2,
            "session_subagents": 0,
            "session_warnings": 0,
            "session_metrics": 2,
        }
        assert connection.execute(
            "SELECT session_id, tool_call_id FROM session_tool_calls ORDER BY session_id, tool_call_id"
        ).fetchall() == [
            ("session-parent-clean", "call-read-1|fc-1"),
            ("session-parent-clean-2", "call-read-1|fc-1"),
        ]
        primary_key_positions = {
            row[1]: row[5]
            for row in connection.execute("PRAGMA table_info(session_tool_calls)").fetchall()
        }
        assert primary_key_positions["session_id"] == 1
        assert primary_key_positions["tool_call_id"] == 2


def _run_extract(
    session_path: Path,
    output_root: Path,
    sqlite_path: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable,
        "-m",
        "self_evolve.extractor.cli",
        "extract",
        str(session_path),
        "--output-root",
        str(output_root),
    ]
    if sqlite_path is not None:
        command.extend(["--sqlite-path", str(sqlite_path)])
    return subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
    )


def _run_dashboard(
    input_root: Path,
    output_path: Path | None = None,
    baseline_session_id: str | None = None,
) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable,
        "-m",
        "self_evolve.extractor.cli",
        "dashboard",
        "--input-root",
        str(input_root),
    ]
    if output_path is not None:
        command.extend(["--output-path", str(output_path)])
    if baseline_session_id is not None:
        command.extend(["--baseline-session-id", baseline_session_id])
    return subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
    )


def _table_counts(connection: sqlite3.Connection) -> dict[str, int]:
    return {
        table_name: connection.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]
        for table_name in (
            "sessions",
            "session_events",
            "session_tool_calls",
            "session_subagents",
            "session_warnings",
            "session_metrics",
        )
    }


def _replacement_fixture_text() -> str:
    replacement_records = [
        {
            "type": "session",
            "version": 3,
            "id": "session-parent-clean",
            "timestamp": "2026-04-23T10:00:00.000Z",
            "cwd": "/home/example/project",
        },
        {
            "type": "message",
            "id": "msg-user-rerun-1",
            "parentId": "session-parent-clean",
            "timestamp": "2026-04-23T10:00:01.000Z",
            "message": {
                "role": "user",
                "timestamp": 1761213601000,
                "content": [{"type": "text", "text": "Summarize the rerun fixture."}],
            },
        },
        {
            "type": "message",
            "id": "msg-assistant-rerun-1",
            "parentId": "msg-user-rerun-1",
            "timestamp": "2026-04-23T10:00:02.000Z",
            "message": {
                "role": "assistant",
                "api": "openai-responses",
                "provider": "openai-codex",
                "model": "gpt-5.4",
                "responseId": "resp-rerun-1",
                "timestamp": 1761213602000,
                "stopReason": "end_turn",
                "usage": {
                    "input": 10,
                    "output": 4,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "totalTokens": 14,
                    "cost": {
                        "input": 0.0001,
                        "output": 0.00008,
                        "cacheRead": 0.0,
                        "cacheWrite": 0.0,
                        "total": 0.00018,
                    },
                },
                "content": [{"type": "text", "text": "Rerun summary complete."}],
            },
        },
    ]
    return "\n".join(json.dumps(record, separators=(",", ":")) for record in replacement_records) + "\n"


def _fixture_with_session_id(fixture_text: str, session_id: str) -> str:
    return fixture_text.replace(
        '"id":"session-parent-clean"',
        f'"id":"{session_id}"',
        1,
    )


def _create_legacy_tool_call_schema(sqlite_path: Path) -> None:
    with sqlite3.connect(sqlite_path) as connection:
        connection.execute(
            """
            CREATE TABLE session_tool_calls (
              session_id TEXT NOT NULL,
              tool_call_id TEXT PRIMARY KEY,
              tool_name TEXT NOT NULL,
              assistant_event_id TEXT,
              tool_result_event_id TEXT,
              is_error INTEGER,
              arguments_json TEXT,
              result_details_json TEXT,
              result_text TEXT
            )
            """
        )
