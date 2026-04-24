from __future__ import annotations

from dataclasses import asdict

from self_evolve.extractor.metrics import calculate_metrics
from self_evolve.extractor.models import (
    EventStatus,
    ExtractedSession,
    ExtractionWarning,
    LinkedSubagent,
    NormalizedEvent,
    SessionMetadata,
    SidechainLink,
    SidechainStatus,
    SubagentSummary,
    ToolCallJoin,
    WarningCode,
    WarningScope,
    WarningSeverity,
)


EXPECTED_PHASE1_METRIC_FIELDS = {
    "session_duration_seconds",
    "time_to_first_tool_call_seconds",
    "assistant_message_count",
    "user_message_count",
    "tool_call_count",
    "tool_result_count",
    "tool_error_count",
    "tool_success_rate",
    "error_then_retry_count",
    "total_input_tokens",
    "total_output_tokens",
    "total_cache_read_tokens",
    "total_cache_write_tokens",
    "total_billed_tokens",
    "total_cost",
    "unknown_record_count",
    "warning_count",
    "subagent_count",
}


def test_calculate_metrics_returns_only_phase1_fields_and_expected_values() -> None:
    extracted_session = ExtractedSession(
        session=SessionMetadata(
            session_id="session-parent-sidechain",
            source_path="/tmp/session-parent-sidechain.jsonl",
            started_at="2026-04-23T11:00:00.000Z",
            ended_at="2026-04-23T11:00:07.000Z",
        ),
        events=[
            _event(
                event_id="msg-user-2",
                sequence=0,
                timestamp="2026-04-23T11:00:01.000Z",
                parent_event_id=None,
                role="user",
                payload={"kind": "message_user", "content_blocks": [{"block_kind": "text", "text": "Inspect fixture layout."}]},
            ),
            _assistant_event(
                event_id="msg-assistant-3",
                sequence=1,
                timestamp="2026-04-23T11:00:02.000Z",
                parent_event_id="msg-user-2",
                usage={
                    "input_tokens": 150,
                    "output_tokens": 55,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "total_tokens": 205,
                    "cost_total": 0.0026,
                },
            ),
            _tool_result_event(
                event_id="msg-tool-2",
                sequence=2,
                timestamp="2026-04-23T11:00:02.200Z",
                parent_event_id="msg-assistant-3",
                tool_call_id="call-agent-1|fc-2",
                tool_name="Agent",
            ),
            _assistant_event(
                event_id="msg-assistant-4",
                sequence=3,
                timestamp="2026-04-23T11:00:03.000Z",
                parent_event_id="msg-tool-2",
                usage={
                    "input_tokens": 100,
                    "output_tokens": 35,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "total_tokens": 135,
                    "cost_total": 0.0017,
                },
            ),
            _tool_result_event(
                event_id="msg-tool-3",
                sequence=4,
                timestamp="2026-04-23T11:00:03.100Z",
                parent_event_id="msg-assistant-4",
                tool_call_id="call-get-subagent-1|fc-3",
                tool_name="get_subagent_result",
            ),
            NormalizedEvent(
                event_id="unknown-1",
                record_kind="unknown",
                sequence=5,
                timestamp="2026-04-23T11:00:03.500Z",
                status=EventStatus.UNKNOWN_RECORD_KIND,
                payload={"kind": "unknown", "unknown_type": "future_record_type"},
                raw={"type": "future_record_type"},
            ),
            _assistant_event(
                event_id="msg-assistant-5",
                sequence=6,
                timestamp="2026-04-23T11:00:04.000Z",
                parent_event_id="msg-tool-3",
                usage={
                    "input_tokens": 90,
                    "output_tokens": 28,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "total_tokens": 118,
                    "cost_total": 0.00146,
                },
            ),
        ],
        tool_calls=[
            ToolCallJoin(
                session_id="session-parent-sidechain",
                tool_call_id="call-agent-1|fc-2",
                tool_name="Agent",
                assistant_event_id="msg-assistant-3",
                tool_result_event_id="msg-tool-2",
                is_error=False,
            ),
            ToolCallJoin(
                session_id="session-parent-sidechain",
                tool_call_id="call-get-subagent-1|fc-3",
                tool_name="get_subagent_result",
                assistant_event_id="msg-assistant-4",
                tool_result_event_id="msg-tool-3",
                is_error=False,
            ),
        ],
        subagents=[
            LinkedSubagent(
                subagent_id="agent-side-1",
                subagent_type="chengfeng",
                description="Inspect fixtures",
                status_text="completed",
                summary=SubagentSummary(),
                sidechain=SidechainLink(status=SidechainStatus.PRESENT),
            )
        ],
        warnings=[
            ExtractionWarning(
                warning_code=WarningCode.UNKNOWN_RECORD_KIND,
                severity=WarningSeverity.WARNING,
                scope=WarningScope.PARENT_SESSION,
                message="Unknown future record type preserved.",
            )
        ],
    )

    calculation = calculate_metrics(extracted_session)
    metrics = asdict(calculation.session_metrics)

    assert set(metrics) == EXPECTED_PHASE1_METRIC_FIELDS
    assert metrics == {
        "session_duration_seconds": 7.0,
        "time_to_first_tool_call_seconds": 2.0,
        "assistant_message_count": 3,
        "user_message_count": 1,
        "tool_call_count": 2,
        "tool_result_count": 2,
        "tool_error_count": 0,
        "tool_success_rate": 1.0,
        "error_then_retry_count": 0,
        "total_input_tokens": 340,
        "total_output_tokens": 118,
        "total_cache_read_tokens": 0,
        "total_cache_write_tokens": 0,
        "total_billed_tokens": 458,
        "total_cost": 0.00576,
        "unknown_record_count": 1,
        "warning_count": 1,
        "subagent_count": 1,
    }
    assert calculation.per_turn_timings == [
        _per_turn_timing("msg-assistant-3", "msg-user-2", "user", 1.0),
        _per_turn_timing("msg-assistant-4", "msg-tool-2", "toolResult", 0.8),
        _per_turn_timing("msg-assistant-5", "msg-tool-3", "toolResult", 0.9),
    ]
    assert "heuristic" in calculation.heuristic_metric_notes["error_then_retry_count"]


def test_error_then_retry_count_is_heuristic_and_counts_only_later_same_tool_success() -> None:
    extracted_session = ExtractedSession(
        session=SessionMetadata(
            session_id="session-retry-heuristic",
            source_path="/tmp/session-retry-heuristic.jsonl",
            started_at="2026-04-23T12:00:00.000Z",
            ended_at="2026-04-23T12:00:03.000Z",
        ),
        events=[
            _assistant_event(
                event_id="assistant-1",
                sequence=0,
                timestamp="2026-04-23T12:00:00.500Z",
                parent_event_id=None,
                usage={
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "total_tokens": 15,
                    "cost_total": 0.00015,
                },
            ),
            _tool_result_event(
                event_id="tool-1",
                sequence=1,
                timestamp="2026-04-23T12:00:00.700Z",
                parent_event_id="assistant-1",
                tool_call_id="call-read-1",
                tool_name="read",
            ),
            _assistant_event(
                event_id="assistant-2",
                sequence=2,
                timestamp="2026-04-23T12:00:01.000Z",
                parent_event_id="tool-1",
                usage={
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "total_tokens": 15,
                    "cost_total": 0.00015,
                },
            ),
            _tool_result_event(
                event_id="tool-2",
                sequence=3,
                timestamp="2026-04-23T12:00:01.200Z",
                parent_event_id="assistant-2",
                tool_call_id="call-bash-1",
                tool_name="bash",
            ),
            _assistant_event(
                event_id="assistant-3",
                sequence=4,
                timestamp="2026-04-23T12:00:02.000Z",
                parent_event_id="tool-2",
                usage={
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "total_tokens": 15,
                    "cost_total": 0.00015,
                },
            ),
            _tool_result_event(
                event_id="tool-3",
                sequence=5,
                timestamp="2026-04-23T12:00:02.200Z",
                parent_event_id="assistant-3",
                tool_call_id="call-read-2",
                tool_name="read",
            ),
        ],
        tool_calls=[
            ToolCallJoin(
                session_id="session-retry-heuristic",
                tool_call_id="call-read-1",
                tool_name="read",
                assistant_event_id="assistant-1",
                tool_result_event_id="tool-1",
                is_error=True,
            ),
            ToolCallJoin(
                session_id="session-retry-heuristic",
                tool_call_id="call-bash-1",
                tool_name="bash",
                assistant_event_id="assistant-2",
                tool_result_event_id="tool-2",
                is_error=True,
            ),
            ToolCallJoin(
                session_id="session-retry-heuristic",
                tool_call_id="call-read-2",
                tool_name="read",
                assistant_event_id="assistant-3",
                tool_result_event_id="tool-3",
                is_error=False,
            ),
        ],
    )

    calculation = calculate_metrics(extracted_session)

    assert calculation.session_metrics.error_then_retry_count == 1
    assert calculation.session_metrics.tool_error_count == 2
    assert calculation.session_metrics.tool_success_rate == 1 / 3
    assert calculation.heuristic_metric_notes == {
        "error_then_retry_count": (
            "heuristic: counts failed tool results followed later by a "
            "successful result for the same tool name"
        )
    }


def _event(
    *,
    event_id: str,
    sequence: int,
    timestamp: str,
    parent_event_id: str | None,
    role: str,
    payload: dict[str, object],
) -> NormalizedEvent:
    return NormalizedEvent(
        event_id=event_id,
        record_kind="message",
        sequence=sequence,
        timestamp=timestamp,
        parent_event_id=parent_event_id,
        role=role,
        payload=payload,
    )



def _assistant_event(
    *,
    event_id: str,
    sequence: int,
    timestamp: str,
    parent_event_id: str | None,
    usage: dict[str, object],
) -> NormalizedEvent:
    return _event(
        event_id=event_id,
        sequence=sequence,
        timestamp=timestamp,
        parent_event_id=parent_event_id,
        role="assistant",
        payload={"kind": "message_assistant", "usage": usage},
    )



def _tool_result_event(
    *,
    event_id: str,
    sequence: int,
    timestamp: str,
    parent_event_id: str,
    tool_call_id: str,
    tool_name: str,
) -> NormalizedEvent:
    return _event(
        event_id=event_id,
        sequence=sequence,
        timestamp=timestamp,
        parent_event_id=parent_event_id,
        role="toolResult",
        payload={
            "kind": "message_tool_result",
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "is_error": False,
        },
    )



def _per_turn_timing(
    assistant_event_id: str,
    parent_event_id: str,
    parent_role: str,
    duration_seconds: float,
) -> object:
    from self_evolve.extractor.metrics import PerTurnTiming

    return PerTurnTiming(
        assistant_event_id=assistant_event_id,
        parent_event_id=parent_event_id,
        parent_role=parent_role,
        duration_seconds=duration_seconds,
    )
