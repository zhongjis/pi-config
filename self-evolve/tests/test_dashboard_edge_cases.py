from __future__ import annotations

import json
from pathlib import Path

import pytest

from self_evolve.dashboard.loader import SessionExport, load_session_exports
from self_evolve.dashboard.render import render_dashboard_html
from self_evolve.dashboard.view_models import build_dashboard_view_model


def test_load_session_exports_sorts_by_started_at_descending(tmp_path: Path) -> None:
    older = _write_export(tmp_path, "session-older", "2026-04-23T10:00:00.000Z")
    newer = _write_export(tmp_path, "session-newer", "2026-04-23T12:00:00.000Z")

    exports = load_session_exports(tmp_path)

    assert [export.session_id for export in exports] == ["session-newer", "session-older"]
    assert exports[0].export_path == newer.resolve()
    assert exports[1].export_path == older.resolve()


def test_load_session_exports_rejects_missing_session_id(tmp_path: Path) -> None:
    broken_payload = {
        "schema_version": 1,
        "session": {"started_at": "2026-04-23T12:00:00.000Z", "cwd": "/home/example/project"},
        "events": [],
        "tool_calls": [],
        "subagents": [],
        "metrics": {},
        "warnings": [],
    }
    (tmp_path / "broken.json").write_text(json.dumps(broken_payload), encoding="utf-8")

    with pytest.raises(ValueError, match="missing session.session_id"):
        load_session_exports(tmp_path)


def test_build_dashboard_view_model_disables_comparison_for_single_session() -> None:
    dashboard = build_dashboard_view_model(
        [_session_export("session-only", "2026-04-23T12:00:00.000Z", "/home/example/project-a")],
        input_root=Path("/tmp/dashboard-input"),
    )

    comparison = dashboard.baseline_comparison
    assert comparison.status == "disabled"
    assert comparison.empty_title == "No baseline candidate available"
    assert comparison.empty_description == "Persist at least one additional session export to compare against the focused session."


def test_build_dashboard_view_model_invalid_baseline_selection_stays_disabled() -> None:
    dashboard = build_dashboard_view_model(
        [
            _session_export("session-selected", "2026-04-23T12:00:00.000Z", "/home/example/project-a", is_incomplete=True),
            _session_export("session-baseline", "2026-04-23T11:00:00.000Z", "/home/example/project-a"),
        ],
        input_root=Path("/tmp/dashboard-input"),
        baseline_session_id="missing-session",
    )

    comparison = dashboard.baseline_comparison
    assert comparison.status == "invalid_selection"
    assert comparison.fit_label == "Invalid baseline"
    assert comparison.empty_title == "Selected baseline is unavailable"
    assert comparison.empty_description == "missing-session is not a valid baseline candidate for the current focused session."


def test_render_dashboard_html_shows_not_recorded_and_weak_comparison_caveats() -> None:
    dashboard = build_dashboard_view_model(
        [
            _session_export(
                "session-selected",
                "2026-04-23T12:00:00.000Z",
                "/home/example/project-a",
                is_incomplete=True,
                time_to_first_tool_call_seconds=None,
            ),
            _session_export(
                "session-baseline",
                "2026-04-23T11:00:00.000Z",
                "/home/example/project-b",
                time_to_first_tool_call_seconds=5.0,
            ),
        ],
        input_root=Path("/tmp/dashboard-input"),
        baseline_session_id="session-baseline",
    )

    html = render_dashboard_html(dashboard)

    assert "Not recorded" in html
    assert "Inconclusive fit" in html
    assert "Task similarity unknown — metrics may not be directly comparable." in html
    assert "Extraction health differs — deltas may reflect parser confidence, not session behavior." in html
    assert "Project context differs or is unverified — treat deltas as weaker evidence." in html


def _write_export(tmp_path: Path, session_id: str, started_at: str) -> Path:
    export_path = tmp_path / f"{session_id}.json"
    payload = {
        "schema_version": 1,
        "session": {
            "session_id": session_id,
            "started_at": started_at,
            "cwd": "/home/example/project",
        },
        "events": [],
        "tool_calls": [],
        "subagents": [],
        "metrics": {},
        "warnings": [],
    }
    export_path.write_text(json.dumps(payload), encoding="utf-8")
    return export_path


def _session_export(
    session_id: str,
    started_at: str,
    cwd: str,
    *,
    is_incomplete: bool = False,
    time_to_first_tool_call_seconds: float | None = None,
) -> SessionExport:
    payload = {
        "schema_version": 1,
        "session": {
            "session_id": session_id,
            "started_at": started_at,
            "ended_at": started_at,
            "cwd": cwd,
            "cwd_locator": f"--{Path(cwd).name}--",
            "is_incomplete": is_incomplete,
            "incomplete_reasons": ["truncated_final_line"] if is_incomplete else [],
            "line_counts": {"malformed": 1 if is_incomplete else 0, "unknown": 1 if is_incomplete else 0},
        },
        "events": [],
        "tool_calls": [{"tool_name": "read", "assistant_event_id": "a1", "tool_result_event_id": None}],
        "subagents": [],
        "metrics": {
            "session_duration_seconds": 300.0 if is_incomplete else 120.0,
            "total_billed_tokens": 8000 if is_incomplete else 3000,
            "total_cost": 12.5 if is_incomplete else 2.5,
            "tool_success_rate": 0.5 if is_incomplete else 1.0,
            "error_then_retry_count": 5 if is_incomplete else 0,
            "time_to_first_tool_call_seconds": time_to_first_tool_call_seconds,
            "tool_call_count": 1,
            "tool_result_count": 1,
            "tool_error_count": 0,
            "total_input_tokens": 100,
            "total_output_tokens": 50,
            "total_cache_read_tokens": 0,
            "total_cache_write_tokens": 0,
            "unknown_record_count": 1 if is_incomplete else 0,
            "warning_count": 1 if is_incomplete else 0,
        },
        "warnings": [],
    }
    return SessionExport(
        export_path=Path(f"/tmp/{session_id}.json"),
        payload=payload,
        session_id=session_id,
        started_at=started_at,
        cwd=cwd,
    )
