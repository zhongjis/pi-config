from __future__ import annotations

from pathlib import Path

from self_evolve.dashboard.loader import SessionExport
from self_evolve.dashboard.view_models import build_session_list_view_model


def test_build_session_list_view_model_caps_badges_and_keeps_contract_gaps() -> None:
    view_model = build_session_list_view_model(
        [
            _session_export(
                session_id="session-steady",
                started_at="2026-04-23T11:00:00.000Z",
                cwd="/home/example/project-steady",
                session_payload={"is_incomplete": False, "line_counts": {"malformed": 0, "unknown": 0}},
                metrics_payload={
                    "session_duration_seconds": 12.0,
                    "total_billed_tokens": 120,
                    "total_cost": 0.12,
                    "tool_success_rate": 1.0,
                    "error_then_retry_count": 0,
                    "unknown_record_count": 0,
                    "warning_count": 0,
                },
            ),
            _session_export(
                session_id="session-flagged",
                started_at="2026-04-23T12:00:00.000Z",
                cwd="/home/example/project-flagged",
                session_payload={"is_incomplete": True, "line_counts": {"malformed": 2, "unknown": 3}},
                metrics_payload={
                    "session_duration_seconds": 300.0,
                    "total_billed_tokens": 8000,
                    "total_cost": 12.5,
                    "tool_success_rate": 0.2,
                    "error_then_retry_count": 5,
                    "unknown_record_count": 3,
                    "warning_count": 2,
                },
            ),
        ]
    )

    flagged_row = next(row for row in view_model.rows if row.session_id == "session-flagged")

    assert view_model.review_count == 1
    assert flagged_row.source_label == "Contract gap"
    assert flagged_row.config_version_label == "Contract gap"
    assert flagged_row.confidence_label == "Low confidence"
    assert [badge.label for badge in flagged_row.badges] == ["Incomplete", "Extraction Weird"]
    assert len(flagged_row.badges) == 2
    assert flagged_row.baseline_action_label == "--baseline-session-id session-flagged"


def _session_export(
    *,
    session_id: str,
    started_at: str,
    cwd: str,
    session_payload: dict[str, object],
    metrics_payload: dict[str, object],
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
        "events": [],
        "tool_calls": [],
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
