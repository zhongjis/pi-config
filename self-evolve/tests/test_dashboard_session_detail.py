from __future__ import annotations

from pathlib import Path

from self_evolve.dashboard.loader import SessionExport
from self_evolve.dashboard.view_models import build_dashboard_view_model


def test_build_dashboard_view_model_focuses_top_triage_session_for_detail() -> None:
    dashboard = build_dashboard_view_model(
        [
            _session_export(
                session_id="session-steady",
                started_at="2026-04-23T11:00:00.000Z",
                cwd="/home/example/project-steady",
                session_payload={
                    "ended_at": "2026-04-23T11:00:12.000Z",
                    "is_incomplete": False,
                    "incomplete_reasons": [],
                    "line_counts": {"malformed": 0, "unknown": 0},
                },
                metrics_payload={
                    "session_duration_seconds": 12.0,
                    "total_billed_tokens": 120,
                    "total_cost": 0.12,
                    "time_to_first_tool_call_seconds": 2.0,
                    "tool_call_count": 1,
                    "tool_result_count": 1,
                    "tool_error_count": 0,
                    "tool_success_rate": 1.0,
                    "error_then_retry_count": 0,
                    "total_input_tokens": 80,
                    "total_output_tokens": 40,
                    "total_cache_read_tokens": 0,
                    "total_cache_write_tokens": 0,
                    "unknown_record_count": 0,
                    "warning_count": 0,
                },
                events_payload=[
                    {"timestamp": "2026-04-23T11:00:00.000Z", "role": "user", "payload": {"kind": "message_user"}},
                    {"timestamp": "2026-04-23T11:00:02.000Z", "role": "assistant", "payload": {"kind": "message_assistant"}},
                ],
                tool_calls_payload=[
                    {"tool_name": "read", "assistant_event_id": "a1", "tool_result_event_id": "t1"}
                ],
            ),
            _session_export(
                session_id="session-flagged",
                started_at="2026-04-23T12:00:00.000Z",
                cwd="/home/example/project-flagged",
                session_payload={
                    "ended_at": "2026-04-23T12:05:00.000Z",
                    "is_incomplete": True,
                    "incomplete_reasons": ["truncated_final_line"],
                    "line_counts": {"malformed": 2, "unknown": 3},
                },
                metrics_payload={
                    "session_duration_seconds": 300.0,
                    "total_billed_tokens": 8000,
                    "total_cost": 12.5,
                    "tool_call_count": 2,
                    "tool_result_count": 1,
                    "tool_error_count": 1,
                    "tool_success_rate": 0.5,
                    "error_then_retry_count": 5,
                    "total_input_tokens": 6000,
                    "total_output_tokens": 2000,
                    "total_cache_read_tokens": 100,
                    "total_cache_write_tokens": 0,
                    "unknown_record_count": 3,
                    "warning_count": 2,
                },
                events_payload=[],
                tool_calls_payload=[
                    {"tool_name": "read", "assistant_event_id": "a1", "tool_result_event_id": None},
                    {"tool_name": "grep", "assistant_event_id": None, "tool_result_event_id": None},
                ],
            ),
        ],
        input_root=Path("/tmp/dashboard-input"),
    )

    assert dashboard.session_detail.focused_session_id == "session-flagged"
    assert dashboard.session_detail.focus_reason == "Current detail follows the first row in the triage order above."
    assert [metric.value for metric in dashboard.session_detail.headline_metrics] == [
        "5m 0s",
        "8,000",
        "$12.5000",
        "Not recorded",
    ]
    assert dashboard.session_detail.timing_fields[2].value == "Not recorded"
    assert dashboard.session_detail.tool_fields[5].value == "grep, read"
    assert dashboard.session_detail.tool_fields[6].value == "0 of 2 linked"
    assert dashboard.session_detail.extraction_fields[0].value == "Low confidence"
    assert dashboard.session_detail.extraction_fields[2].value == "truncated_final_line"


def _session_export(
    *,
    session_id: str,
    started_at: str,
    cwd: str,
    session_payload: dict[str, object],
    metrics_payload: dict[str, object],
    events_payload: list[dict[str, object]],
    tool_calls_payload: list[dict[str, object]],
) -> SessionExport:
    payload = {
        "schema_version": 1,
        "session": {
            "session_id": session_id,
            "started_at": started_at,
            "cwd": cwd,
            "cwd_locator": f"--{Path(cwd).name}--",
            **session_payload,
        },
        "events": events_payload,
        "tool_calls": tool_calls_payload,
        "subagents": [],
        "metrics": metrics_payload,
        "warnings": [],
    }
    return SessionExport(
        export_path=Path(f"/tmp/{session_id}.json"),
        payload=payload,
        session_id=session_id,
        started_at=started_at,
        cwd=cwd,
    )
