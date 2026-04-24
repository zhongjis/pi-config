from __future__ import annotations

"""Phase 1 metric calculation helpers.

Formula/unit notes:
- ``session_duration_seconds`` = ``session.ended_at - session.started_at`` in seconds.
- ``per_turn_timings`` are individual assistant turn latencies in seconds from the
  parent user/tool-result event to the assistant event.
- ``time_to_first_tool_call_seconds`` = earliest assistant event with a joined
  tool call minus ``session.started_at`` in seconds.
- token and cost totals are summed from assistant-message ``payload['usage']``.
- ``tool_success_rate`` = successful completed tool results / completed tool
  results, where completed means a joined tool result with a known ``is_error``.
- ``error_then_retry_count`` is a heuristic: it counts failed tool results that
  are followed later by a successful result for the same tool name.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from self_evolve.extractor.models import ExtractedSession, NormalizedEvent, SessionMetrics, ToolCallJoin


@dataclass(slots=True, frozen=True)
class PerTurnTiming:
    """One assistant turn latency in seconds."""

    assistant_event_id: str | None
    parent_event_id: str | None
    parent_role: str
    duration_seconds: float


@dataclass(slots=True)
class MetricCalculation:
    """Calculated persisted metrics plus non-persisted helper metrics."""

    session_metrics: SessionMetrics
    per_turn_timings: list[PerTurnTiming] = field(default_factory=list)
    heuristic_metric_notes: dict[str, str] = field(
        default_factory=lambda: {
            "error_then_retry_count": (
                "heuristic: counts failed tool results followed later by a "
                "successful result for the same tool name"
            )
        }
    )


def calculate_metrics(extracted_session: ExtractedSession) -> MetricCalculation:
    """Calculate only the agreed Phase 1 metrics from normalized session models."""

    events_by_id = {
        event.event_id: event for event in extracted_session.events if event.event_id is not None
    }
    per_turn_timings = _calculate_per_turn_timings(extracted_session.events, events_by_id)

    metrics = SessionMetrics(
        session_duration_seconds=_seconds_between(
            extracted_session.session.started_at,
            extracted_session.session.ended_at,
        ),
        time_to_first_tool_call_seconds=_time_to_first_tool_call_seconds(
            extracted_session.tool_calls,
            events_by_id,
            extracted_session.session.started_at,
        ),
        assistant_message_count=sum(
            1 for event in extracted_session.events if _is_message_event(event, "message_assistant", "assistant")
        ),
        user_message_count=sum(
            1 for event in extracted_session.events if _is_message_event(event, "message_user", "user")
        ),
        tool_call_count=len(extracted_session.tool_calls),
        tool_result_count=sum(1 for tool_call in extracted_session.tool_calls if tool_call.tool_result_event_id),
        tool_error_count=sum(1 for tool_call in extracted_session.tool_calls if tool_call.is_error is True),
        tool_success_rate=_tool_success_rate(extracted_session.tool_calls),
        error_then_retry_count=_error_then_retry_count(extracted_session.tool_calls, events_by_id),
        total_input_tokens=sum(_usage_int(event, "input_tokens") for event in extracted_session.events),
        total_output_tokens=sum(_usage_int(event, "output_tokens") for event in extracted_session.events),
        total_cache_read_tokens=sum(_usage_int(event, "cache_read_tokens") for event in extracted_session.events),
        total_cache_write_tokens=sum(_usage_int(event, "cache_write_tokens") for event in extracted_session.events),
        total_billed_tokens=sum(_usage_int(event, "total_tokens") for event in extracted_session.events),
        total_cost=round(sum(_usage_float(event, "cost_total") for event in extracted_session.events), 12),
        unknown_record_count=sum(
            1
            for event in extracted_session.events
            if event.record_kind == "unknown" or event.status.value == "unknown_record_kind"
        ),
        warning_count=len(extracted_session.warnings),
        subagent_count=len(extracted_session.subagents),
    )

    return MetricCalculation(
        session_metrics=metrics,
        per_turn_timings=per_turn_timings,
    )


def _calculate_per_turn_timings(
    events: list[NormalizedEvent],
    events_by_id: dict[str, NormalizedEvent],
) -> list[PerTurnTiming]:
    timings: list[PerTurnTiming] = []
    for event in events:
        if not _is_message_event(event, "message_assistant", "assistant"):
            continue
        if event.parent_event_id is None:
            continue

        parent_event = events_by_id.get(event.parent_event_id)
        if parent_event is None:
            continue
        if not (
            _is_message_event(parent_event, "message_user", "user")
            or _is_message_event(parent_event, "message_tool_result", "toolResult")
        ):
            continue

        duration_seconds = _seconds_between(parent_event.timestamp, event.timestamp)
        if duration_seconds is None:
            continue

        timings.append(
            PerTurnTiming(
                assistant_event_id=event.event_id,
                parent_event_id=parent_event.event_id,
                parent_role=parent_event.role or str(parent_event.payload.get("kind") or parent_event.record_kind),
                duration_seconds=duration_seconds,
            )
        )

    return timings


def _time_to_first_tool_call_seconds(
    tool_calls: list[ToolCallJoin],
    events_by_id: dict[str, NormalizedEvent],
    started_at: str | None,
) -> float | None:
    start = _parse_timestamp(started_at)
    if start is None:
        return None

    tool_timestamps = []
    for tool_call in tool_calls:
        if tool_call.assistant_event_id is None:
            continue
        assistant_event = events_by_id.get(tool_call.assistant_event_id)
        if assistant_event is None:
            continue
        assistant_timestamp = _parse_timestamp(assistant_event.timestamp)
        if assistant_timestamp is None:
            continue
        tool_timestamps.append(assistant_timestamp)

    if not tool_timestamps:
        return None

    delta = min(tool_timestamps) - start
    if delta.total_seconds() < 0:
        return None
    return round(delta.total_seconds(), 6)


def _tool_success_rate(tool_calls: list[ToolCallJoin]) -> float | None:
    completed_results = [tool_call for tool_call in tool_calls if tool_call.tool_result_event_id and tool_call.is_error is not None]
    if not completed_results:
        return None

    successful_results = sum(1 for tool_call in completed_results if tool_call.is_error is False)
    return successful_results / len(completed_results)


def _error_then_retry_count(
    tool_calls: list[ToolCallJoin],
    events_by_id: dict[str, NormalizedEvent],
) -> int:
    ordered_tool_calls = sorted(tool_calls, key=lambda tool_call: _tool_sort_key(tool_call, events_by_id))
    count = 0

    for index, tool_call in enumerate(ordered_tool_calls):
        if tool_call.is_error is not True:
            continue
        if any(
            later_call.tool_name == tool_call.tool_name and later_call.is_error is False
            for later_call in ordered_tool_calls[index + 1 :]
        ):
            count += 1

    return count


def _tool_sort_key(tool_call: ToolCallJoin, events_by_id: dict[str, NormalizedEvent]) -> tuple[int, str]:
    for event_id in (tool_call.tool_result_event_id, tool_call.assistant_event_id):
        if event_id is None:
            continue
        event = events_by_id.get(event_id)
        if event is not None:
            return (event.sequence, tool_call.tool_call_id)
    return (10**9, tool_call.tool_call_id)


def _usage_int(event: NormalizedEvent, key: str) -> int:
    usage = _usage_summary(event)
    value = usage.get(key, 0)
    return int(value) if isinstance(value, int | float) else 0


def _usage_float(event: NormalizedEvent, key: str) -> float:
    usage = _usage_summary(event)
    value = usage.get(key, 0.0)
    return float(value) if isinstance(value, int | float) else 0.0


def _usage_summary(event: NormalizedEvent) -> dict[str, Any]:
    if not _is_message_event(event, "message_assistant", "assistant"):
        return {}
    usage = event.payload.get("usage")
    return usage if isinstance(usage, dict) else {}


def _is_message_event(event: NormalizedEvent, payload_kind: str, role: str) -> bool:
    if event.record_kind != "message":
        return False
    kind = event.payload.get("kind")
    return kind == payload_kind or event.role == role


def _seconds_between(started_at: str | None, ended_at: str | None) -> float | None:
    start = _parse_timestamp(started_at)
    end = _parse_timestamp(ended_at)
    if start is None or end is None:
        return None

    delta = end - start
    if delta.total_seconds() < 0:
        return None
    return round(delta.total_seconds(), 6)


def _parse_timestamp(timestamp: str | None) -> datetime | None:
    if timestamp is None:
        return None
    try:
        return datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return None
