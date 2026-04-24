from __future__ import annotations

from pathlib import Path

from self_evolve.dashboard.loader import SessionExport
from self_evolve.dashboard.view_models import build_dashboard_view_model


def test_build_dashboard_view_model_requires_explicit_baseline_selection() -> None:
    dashboard = build_dashboard_view_model(
        [_session_export("session-selected", "2026-04-23T12:00:00.000Z", "/home/example/project-a", True, 300.0, 12.5, 8000, 0.5, 5, None), _session_export("session-baseline", "2026-04-23T11:00:00.000Z", "/home/example/project-a", False, 120.0, 2.5, 3000, 1.0, 0, 5.0)],
        input_root=Path("/tmp/dashboard-input"),
    )

    assert dashboard.baseline_comparison.status == "needs_selection"
    assert dashboard.baseline_comparison.selected_session_id == "session-selected"
    assert dashboard.baseline_comparison.candidates[0].choice_label == "--baseline-session-id session-baseline"


def test_build_dashboard_view_model_renders_real_baseline_comparison() -> None:
    dashboard = build_dashboard_view_model(
        [_session_export("session-selected", "2026-04-23T12:00:00.000Z", "/home/example/project-a", True, 300.0, 12.5, 8000, 0.5, 5, None), _session_export("session-baseline", "2026-04-23T11:00:00.000Z", "/home/example/project-a", False, 120.0, 2.5, 3000, 1.0, 0, 5.0)],
        input_root=Path("/tmp/dashboard-input"),
        baseline_session_id="session-baseline",
    )

    comparison = dashboard.baseline_comparison
    assert comparison.status == "ready"
    assert comparison.baseline_session_id == "session-baseline"
    assert comparison.fit_label == "Inconclusive fit"
    assert comparison.fit_tone == "inconclusive"
    assert comparison.metrics[0].label == "Duration"
    assert comparison.metrics[0].absolute_delta == "+3m 0s"
    assert comparison.metrics[0].percent_delta == "+150%"
    assert comparison.metrics[3].label == "Tool success rate"
    assert comparison.metrics[3].absolute_delta == "-50 pp"
    assert comparison.metrics[5].absolute_delta == "Not recorded"
    assert "Task similarity unknown — metrics may not be directly comparable." in comparison.caveats
    assert "Source unknown in the current Module 1 contract — same-source ranking is unavailable." in comparison.caveats
    assert comparison.candidates[0].is_selected is True


def _session_export(
    session_id: str,
    started_at: str,
    cwd: str,
    is_incomplete: bool,
    duration: float,
    total_cost: float,
    billed_tokens: int,
    tool_success_rate: float,
    error_then_retry_count: int,
    time_to_first_tool_call_seconds: float | None,
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
            "session_duration_seconds": duration,
            "total_billed_tokens": billed_tokens,
            "total_cost": total_cost,
            "tool_success_rate": tool_success_rate,
            "error_then_retry_count": error_then_retry_count,
            "time_to_first_tool_call_seconds": time_to_first_tool_call_seconds,
            "tool_call_count": 1,
            "tool_result_count": 1,
            "tool_error_count": 0,
            "total_input_tokens": billed_tokens // 2,
            "total_output_tokens": billed_tokens // 2,
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
