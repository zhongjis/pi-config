from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePath
from statistics import median
from typing import Any, Sequence

from self_evolve.dashboard.loader import SessionExport

NOT_RECORDED = "Not recorded"
CONTRACT_GAP = "Contract gap"


@dataclass(frozen=True)
class SessionListBadge:
    label: str
    tone: str


@dataclass(frozen=True)
class SessionListRow:
    session_id: str
    timestamp_label: str
    project_label: str
    cwd_label: str
    source_label: str
    source_note: str
    config_version_label: str
    config_version_note: str
    total_duration_label: str
    total_billed_tokens_label: str
    total_cost_label: str
    tool_success_rate_label: str
    error_then_retry_count_label: str
    incomplete_label: str
    unknown_record_count_label: str
    confidence_label: str
    confidence_note: str
    confidence_tone: str
    badges: tuple[SessionListBadge, ...]
    baseline_action_label: str
    baseline_action_note: str
    started_at_sort_key: str
    needs_review: bool


@dataclass(frozen=True)
class SessionListViewModel:
    status: str
    row_count: int
    review_count: int
    queue_rows: tuple[SessionListRow, ...]
    rows: tuple[SessionListRow, ...]
    contract_gap_note: str
    queue_note: str
    empty_title: str
    empty_description: str


@dataclass(frozen=True)
class SessionDetailMetric:
    label: str
    value: str
    note: str


@dataclass(frozen=True)
class SessionDetailField:
    label: str
    value: str
    note: str = ""


@dataclass(frozen=True)
class SessionDetailViewModel:
    status: str
    focused_session_id: str
    focused_project_label: str
    focused_timestamp_label: str
    focus_reason: str
    confidence_label: str
    confidence_tone: str
    confidence_note: str
    headline_metrics: tuple[SessionDetailMetric, ...]
    timing_fields: tuple[SessionDetailField, ...]
    token_fields: tuple[SessionDetailField, ...]
    tool_fields: tuple[SessionDetailField, ...]
    extraction_fields: tuple[SessionDetailField, ...]
    empty_title: str
    empty_description: str


@dataclass(frozen=True)
class ComparisonCandidateViewModel:
    session_id: str
    project_label: str
    timestamp_label: str
    rank_note: str
    choice_label: str
    choice_note: str
    is_selected: bool


@dataclass(frozen=True)
class ComparisonMetricViewModel:
    label: str
    selected_value: str
    baseline_value: str
    absolute_delta: str
    percent_delta: str
    direction_label: str
    tone: str
    bar_width: int
    note: str


@dataclass(frozen=True)
class BaselineComparisonViewModel:
    status: str
    selected_session_id: str
    selected_project_label: str
    selected_timestamp_label: str
    baseline_session_id: str
    baseline_project_label: str
    baseline_timestamp_label: str
    choice_path_note: str
    fit_label: str
    fit_tone: str
    fit_note: str
    caveats: tuple[str, ...]
    candidates: tuple[ComparisonCandidateViewModel, ...]
    metrics: tuple[ComparisonMetricViewModel, ...]
    empty_title: str
    empty_description: str


@dataclass(frozen=True)
class DashboardScaffoldViewModel:
    title: str
    input_root: str
    generated_at: str
    session_count: int
    session_list: SessionListViewModel
    session_detail: SessionDetailViewModel
    baseline_comparison: BaselineComparisonViewModel


@dataclass(frozen=True)
class _PeerThresholds:
    slow_duration_seconds: float | None
    expensive_cost: float | None
    expensive_tokens: float | None


@dataclass(frozen=True)
class _CandidateScore:
    same_project: int
    health_rank: int
    time_gap_seconds: float
    started_at_sort_key: str
    session_id: str


def build_dashboard_view_model(
    session_exports: Sequence[SessionExport],
    *,
    input_root: Path,
    baseline_session_id: str | None = None,
) -> DashboardScaffoldViewModel:
    session_list = build_session_list_view_model(session_exports)
    session_detail = build_session_detail_view_model(session_exports, session_list=session_list)
    return DashboardScaffoldViewModel(
        title="Self-evolve session triage",
        input_root=str(input_root.resolve()),
        generated_at=datetime.now(UTC).isoformat(),
        session_count=len(session_exports),
        session_list=session_list,
        session_detail=session_detail,
        baseline_comparison=build_baseline_comparison_view_model(
            session_exports,
            session_list=session_list,
            session_detail=session_detail,
            baseline_session_id=baseline_session_id,
        ),
    )


def build_session_list_view_model(session_exports: Sequence[SessionExport]) -> SessionListViewModel:
    thresholds = _build_peer_thresholds(session_exports)
    rows = sorted(
        (_build_session_list_row(session_export, thresholds) for session_export in session_exports),
        key=_sort_session_list_row,
        reverse=True,
    )
    queue_rows = tuple(row for row in rows if row.needs_review)[:5] or tuple(rows[:5])
    return SessionListViewModel(
        status="ready" if rows else "empty",
        row_count=len(rows),
        review_count=sum(1 for row in rows if row.needs_review),
        queue_rows=queue_rows,
        rows=tuple(rows),
        contract_gap_note="Source and config version remain visible contract gaps until Module 1 records them durably.",
        queue_note="Queue order favors alert badges and extraction confidence first, then recency. Baseline selection stays explicit per row.",
        empty_title="No persisted session exports found",
        empty_description="Run extract first. The dashboard keeps Session List empty rather than inventing KPIs or placeholder rows.",
    )


def build_session_detail_view_model(
    session_exports: Sequence[SessionExport],
    *,
    session_list: SessionListViewModel | None = None,
) -> SessionDetailViewModel:
    resolved_session_list = session_list or build_session_list_view_model(session_exports)
    if not resolved_session_list.rows:
        return SessionDetailViewModel(
            status="empty",
            focused_session_id=NOT_RECORDED,
            focused_project_label=NOT_RECORDED,
            focused_timestamp_label=NOT_RECORDED,
            focus_reason="",
            confidence_label=NOT_RECORDED,
            confidence_tone="muted",
            confidence_note="",
            headline_metrics=(),
            timing_fields=(),
            token_fields=(),
            tool_fields=(),
            extraction_fields=(),
            empty_title="No focused session available",
            empty_description="Session Detail will populate after Module 1 exports exist. The dashboard does not fabricate a session summary.",
        )

    focused_row = resolved_session_list.rows[0]
    export_by_session_id = {session_export.session_id: session_export for session_export in session_exports}
    focused_export = export_by_session_id.get(focused_row.session_id)
    if focused_export is None:
        return SessionDetailViewModel(
            status="empty",
            focused_session_id=NOT_RECORDED,
            focused_project_label=NOT_RECORDED,
            focused_timestamp_label=NOT_RECORDED,
            focus_reason="",
            confidence_label=NOT_RECORDED,
            confidence_tone="muted",
            confidence_note="",
            headline_metrics=(),
            timing_fields=(),
            token_fields=(),
            tool_fields=(),
            extraction_fields=(),
            empty_title="Focused session could not be loaded",
            empty_description="The triage row exists, but its export payload was not available for Session Detail.",
        )

    session_payload = _mapping(focused_export.payload.get("session"))
    metrics_payload = _mapping(focused_export.payload.get("metrics"))
    line_counts = _mapping(session_payload.get("line_counts"))
    events = _sequence_of_mappings(focused_export.payload.get("events"))
    tool_calls = _sequence_of_mappings(focused_export.payload.get("tool_calls"))
    warnings = _sequence_of_mappings(focused_export.payload.get("warnings"))

    is_incomplete = _bool(session_payload.get("is_incomplete"))
    malformed_count = _number(line_counts.get("malformed"))
    unknown_record_count = _number(metrics_payload.get("unknown_record_count"))
    warning_count = _number(metrics_payload.get("warning_count"))
    if warning_count is None and warnings:
        warning_count = float(len(warnings))

    return SessionDetailViewModel(
        status="ready",
        focused_session_id=focused_export.session_id,
        focused_project_label=focused_row.project_label,
        focused_timestamp_label=focused_row.timestamp_label,
        focus_reason="Current detail follows the first row in the triage order above.",
        confidence_label=focused_row.confidence_label,
        confidence_tone=focused_row.confidence_tone,
        confidence_note=focused_row.confidence_note,
        headline_metrics=(
            SessionDetailMetric(
                label="Duration",
                value=_duration_label(_number(metrics_payload.get("session_duration_seconds"))),
                note="Observed wall-clock session span.",
            ),
            SessionDetailMetric(
                label="Billed tokens",
                value=_integer_label(_number(metrics_payload.get("total_billed_tokens"))),
                note="Current Module 1 aggregate.",
            ),
            SessionDetailMetric(
                label="Cost",
                value=_currency_label(_number(metrics_payload.get("total_cost"))),
                note="Rendered from metrics.total_cost.",
            ),
            SessionDetailMetric(
                label="Time to first tool call",
                value=_duration_label(_number(metrics_payload.get("time_to_first_tool_call_seconds"))),
                note="Not recorded when no linked tool-call timestamp exists.",
            ),
        ),
        timing_fields=(
            SessionDetailField("Started at", _timestamp_label(_string(session_payload.get("started_at")))),
            SessionDetailField("Ended at", _timestamp_label(_string(session_payload.get("ended_at")))),
            SessionDetailField(
                "Observed turn markers",
                _timing_markers_label(events),
                "Derived from normalized event timestamps only.",
            ),
            SessionDetailField("Event count", _integer_label(float(len(events)) if events else None)),
        ),
        token_fields=(
            SessionDetailField("Input tokens", _integer_label(_number(metrics_payload.get("total_input_tokens")))),
            SessionDetailField("Output tokens", _integer_label(_number(metrics_payload.get("total_output_tokens")))),
            SessionDetailField("Cache read", _integer_label(_number(metrics_payload.get("total_cache_read_tokens")))),
            SessionDetailField("Cache write", _integer_label(_number(metrics_payload.get("total_cache_write_tokens")))),
        ),
        tool_fields=(
            SessionDetailField("Total calls", _integer_label(_number(metrics_payload.get("tool_call_count")))),
            SessionDetailField("Completed results", _integer_label(_number(metrics_payload.get("tool_result_count")))),
            SessionDetailField("Failures", _integer_label(_number(metrics_payload.get("tool_error_count")))),
            SessionDetailField("Success rate", _percent_label(_number(metrics_payload.get("tool_success_rate")))),
            SessionDetailField("Retry heuristic", _integer_label(_number(metrics_payload.get("error_then_retry_count")))),
            SessionDetailField("Observed tool names", _tool_names_label(tool_calls)),
            SessionDetailField(
                "Joined call/result links",
                _joined_tool_links_label(tool_calls),
                "Not recorded when joined tool identifiers are absent.",
            ),
        ),
        extraction_fields=(
            SessionDetailField("Confidence", focused_row.confidence_label, focused_row.confidence_note),
            SessionDetailField("Incomplete", _bool_label(is_incomplete)),
            SessionDetailField("Incomplete reasons", _string_list_label(session_payload.get("incomplete_reasons"))),
            SessionDetailField("Malformed lines", _integer_label(malformed_count)),
            SessionDetailField("Unknown records", _integer_label(unknown_record_count)),
            SessionDetailField("Warning count", _integer_label(warning_count)),
            SessionDetailField(
                "Extractor caveat",
                _extraction_caveat(
                    confidence_tone=focused_row.confidence_tone,
                    is_incomplete=is_incomplete,
                    malformed_count=malformed_count,
                    unknown_record_count=unknown_record_count,
                    warning_count=warning_count,
                ),
            ),
        ),
        empty_title="",
        empty_description="",
    )


def build_baseline_comparison_view_model(
    session_exports: Sequence[SessionExport],
    *,
    session_list: SessionListViewModel | None = None,
    session_detail: SessionDetailViewModel | None = None,
    baseline_session_id: str | None = None,
) -> BaselineComparisonViewModel:
    resolved_session_list = session_list or build_session_list_view_model(session_exports)
    resolved_session_detail = session_detail or build_session_detail_view_model(
        session_exports,
        session_list=resolved_session_list,
    )
    if resolved_session_detail.status != "ready":
        return _empty_baseline_comparison(
            empty_title="No selected session available",
            empty_description="Baseline Comparison activates after Session Detail has a focused session.",
        )

    export_by_session_id = {session_export.session_id: session_export for session_export in session_exports}
    selected_export = export_by_session_id.get(resolved_session_detail.focused_session_id)
    if selected_export is None:
        return _empty_baseline_comparison(
            empty_title="Selected session could not be loaded",
            empty_description="The focused Session Detail row does not have a matching export payload.",
        )

    row_by_session_id = {row.session_id: row for row in resolved_session_list.rows}
    selected_row = row_by_session_id.get(selected_export.session_id)
    if selected_row is None:
        return _empty_baseline_comparison(
            empty_title="Selected session could not be ranked",
            empty_description="The focused session is missing from the Session List ranking.",
        )

    candidates = tuple(
        sorted(
            (
                _build_comparison_candidate(selected_export, candidate_export, row_by_session_id)
                for candidate_export in session_exports
                if candidate_export.session_id != selected_export.session_id
            ),
            key=lambda candidate: candidate.rank_sort_key,
        )
    )

    choice_path_note = "Choose a baseline explicitly by rerendering with --baseline-session-id <session_id>. The comparison below never auto-selects one."
    if not candidates:
        return BaselineComparisonViewModel(
            status="disabled",
            selected_session_id=selected_export.session_id,
            selected_project_label=selected_row.project_label,
            selected_timestamp_label=selected_row.timestamp_label,
            baseline_session_id=NOT_RECORDED,
            baseline_project_label=NOT_RECORDED,
            baseline_timestamp_label=NOT_RECORDED,
            choice_path_note=choice_path_note,
            fit_label="Unavailable",
            fit_tone="muted",
            fit_note="At least two persisted sessions are required before a baseline can be chosen.",
            caveats=(),
            candidates=(),
            metrics=(),
            empty_title="No baseline candidate available",
            empty_description="Persist at least one additional session export to compare against the focused session.",
        )

    if baseline_session_id is None:
        return BaselineComparisonViewModel(
            status="needs_selection",
            selected_session_id=selected_export.session_id,
            selected_project_label=selected_row.project_label,
            selected_timestamp_label=selected_row.timestamp_label,
            baseline_session_id=NOT_RECORDED,
            baseline_project_label=NOT_RECORDED,
            baseline_timestamp_label=NOT_RECORDED,
            choice_path_note=choice_path_note,
            fit_label="Waiting for explicit baseline",
            fit_tone="muted",
            fit_note="Comparison stays disabled until a baseline session ID is chosen deliberately.",
            caveats=(),
            candidates=tuple(candidate.view_model for candidate in candidates),
            metrics=(),
            empty_title="Baseline not selected",
            empty_description="Pick one of the candidate session IDs below and rerender the dashboard with --baseline-session-id.",
        )

    selected_candidate = next(
        (candidate for candidate in candidates if candidate.view_model.session_id == baseline_session_id),
        None,
    )
    if selected_candidate is None:
        return BaselineComparisonViewModel(
            status="invalid_selection",
            selected_session_id=selected_export.session_id,
            selected_project_label=selected_row.project_label,
            selected_timestamp_label=selected_row.timestamp_label,
            baseline_session_id=baseline_session_id,
            baseline_project_label=NOT_RECORDED,
            baseline_timestamp_label=NOT_RECORDED,
            choice_path_note=choice_path_note,
            fit_label="Invalid baseline",
            fit_tone="muted",
            fit_note="The requested baseline does not match a valid comparison candidate for the focused session.",
            caveats=(),
            candidates=tuple(candidate.view_model for candidate in candidates),
            metrics=(),
            empty_title="Selected baseline is unavailable",
            empty_description=f"{baseline_session_id} is not a valid baseline candidate for the current focused session.",
        )

    baseline_export = selected_candidate.export
    baseline_row = selected_candidate.row
    metrics = _build_comparison_metrics(selected_export, baseline_export)
    fit_label, fit_tone, fit_note = _comparison_fit(selected_export, baseline_export, selected_row, baseline_row)
    caveats = _comparison_caveats(selected_export, baseline_export, selected_row, baseline_row)
    candidate_view_models = tuple(
        _mark_selected_candidate(candidate.view_model, baseline_session_id)
        for candidate in candidates
    )

    return BaselineComparisonViewModel(
        status="ready",
        selected_session_id=selected_export.session_id,
        selected_project_label=selected_row.project_label,
        selected_timestamp_label=selected_row.timestamp_label,
        baseline_session_id=baseline_export.session_id,
        baseline_project_label=baseline_row.project_label,
        baseline_timestamp_label=baseline_row.timestamp_label,
        choice_path_note=choice_path_note,
        fit_label=fit_label,
        fit_tone=fit_tone,
        fit_note=fit_note,
        caveats=caveats,
        candidates=candidate_view_models,
        metrics=metrics,
        empty_title="",
        empty_description="",
    )


def _build_session_list_row(
    session_export: SessionExport,
    thresholds: _PeerThresholds,
) -> SessionListRow:
    session_payload = _mapping(session_export.payload.get("session"))
    metrics_payload = _mapping(session_export.payload.get("metrics"))
    line_counts = _mapping(session_payload.get("line_counts"))

    malformed_count = _number(line_counts.get("malformed"))
    warning_count = _number(metrics_payload.get("warning_count"))
    unknown_record_count = _number(metrics_payload.get("unknown_record_count"))
    error_then_retry_count = _number(metrics_payload.get("error_then_retry_count"))
    tool_success_rate = _number(metrics_payload.get("tool_success_rate"))
    duration_seconds = _number(metrics_payload.get("session_duration_seconds"))
    total_cost = _number(metrics_payload.get("total_cost"))
    total_billed_tokens = _number(metrics_payload.get("total_billed_tokens"))
    is_incomplete = _bool(session_payload.get("is_incomplete"))

    badges = _build_badges(
        is_incomplete=is_incomplete,
        malformed_count=malformed_count,
        warning_count=warning_count,
        unknown_record_count=unknown_record_count,
        error_then_retry_count=error_then_retry_count,
        tool_success_rate=tool_success_rate,
        duration_seconds=duration_seconds,
        total_cost=total_cost,
        total_billed_tokens=total_billed_tokens,
        thresholds=thresholds,
    )
    confidence_label, confidence_note, confidence_tone = _build_confidence(
        is_incomplete=is_incomplete,
        malformed_count=malformed_count,
        warning_count=warning_count,
        unknown_record_count=unknown_record_count,
    )

    cwd = _string(session_payload.get("cwd"))
    cwd_locator = _string(session_payload.get("cwd_locator"))
    project_label = _project_label(cwd, cwd_locator)

    return SessionListRow(
        session_id=session_export.session_id,
        timestamp_label=_timestamp_label(session_export.started_at),
        project_label=project_label,
        cwd_label=cwd or cwd_locator or NOT_RECORDED,
        source_label=CONTRACT_GAP,
        source_note="Module 1 extension required",
        config_version_label=CONTRACT_GAP,
        config_version_note="Module 1 extension required",
        total_duration_label=_duration_label(duration_seconds),
        total_billed_tokens_label=_integer_label(total_billed_tokens),
        total_cost_label=_currency_label(total_cost),
        tool_success_rate_label=_percent_label(tool_success_rate),
        error_then_retry_count_label=_integer_label(error_then_retry_count),
        incomplete_label=_bool_label(is_incomplete),
        unknown_record_count_label=_integer_label(unknown_record_count),
        confidence_label=confidence_label,
        confidence_note=confidence_note,
        confidence_tone=confidence_tone,
        badges=badges,
        baseline_action_label=f"--baseline-session-id {session_export.session_id}",
        baseline_action_note="Rerender the dashboard with this flag to compare against the focused session.",
        started_at_sort_key=session_export.started_at or "",
        needs_review=bool(badges) or confidence_tone != "ok",
    )


def _build_badges(
    *,
    is_incomplete: bool | None,
    malformed_count: float | None,
    warning_count: float | None,
    unknown_record_count: float | None,
    error_then_retry_count: float | None,
    tool_success_rate: float | None,
    duration_seconds: float | None,
    total_cost: float | None,
    total_billed_tokens: float | None,
    thresholds: _PeerThresholds,
) -> tuple[SessionListBadge, ...]:
    badge_candidates: list[SessionListBadge] = []
    if is_incomplete is True:
        badge_candidates.append(SessionListBadge(label="Incomplete", tone="error"))
    if any(value and value > 0 for value in (malformed_count, warning_count, unknown_record_count)):
        badge_candidates.append(SessionListBadge(label="Extraction Weird", tone="warning"))
    if error_then_retry_count is not None and error_then_retry_count >= 2:
        badge_candidates.append(SessionListBadge(label="Retry Storm", tone="warning"))
    if tool_success_rate is not None and tool_success_rate < 0.8:
        badge_candidates.append(SessionListBadge(label="Tool Fragile", tone="warning"))
    if (
        thresholds.slow_duration_seconds is not None
        and duration_seconds is not None
        and duration_seconds >= thresholds.slow_duration_seconds
    ):
        badge_candidates.append(SessionListBadge(label="Slow", tone="warning"))
    if (
        (thresholds.expensive_cost is not None and total_cost is not None and total_cost >= thresholds.expensive_cost)
        or (
            thresholds.expensive_tokens is not None
            and total_billed_tokens is not None
            and total_billed_tokens >= thresholds.expensive_tokens
        )
    ):
        badge_candidates.append(SessionListBadge(label="Expensive", tone="warning"))
    return tuple(badge_candidates[:2])


def _build_confidence(
    *,
    is_incomplete: bool | None,
    malformed_count: float | None,
    warning_count: float | None,
    unknown_record_count: float | None,
) -> tuple[str, str, str]:
    if is_incomplete is True:
        return ("Low confidence", "Extractor marked this session incomplete.", "error")
    if any(value and value > 0 for value in (malformed_count, warning_count, unknown_record_count)):
        return ("Use caution", "Warnings or unknown records may affect interpretation.", "warning")
    if None in (is_incomplete, warning_count, unknown_record_count):
        return (NOT_RECORDED, "Extraction-health signals are incomplete.", "muted")
    return ("Normal confidence", "No extraction-health alerts were recorded.", "ok")


def _build_peer_thresholds(session_exports: Sequence[SessionExport]) -> _PeerThresholds:
    durations = [
        value
        for value in (_number(_mapping(export.payload.get("metrics")).get("session_duration_seconds")) for export in session_exports)
        if value is not None
    ]
    costs = [
        value
        for value in (_number(_mapping(export.payload.get("metrics")).get("total_cost")) for export in session_exports)
        if value is not None
    ]
    billed_tokens = [
        value
        for value in (_number(_mapping(export.payload.get("metrics")).get("total_billed_tokens")) for export in session_exports)
        if value is not None
    ]
    return _PeerThresholds(
        slow_duration_seconds=_median_multiplier_threshold(durations),
        expensive_cost=_median_multiplier_threshold(costs),
        expensive_tokens=_median_multiplier_threshold(billed_tokens),
    )


def _median_multiplier_threshold(values: Sequence[float], multiplier: float = 1.5) -> float | None:
    if len(values) < 2:
        return None
    return float(median(values) * multiplier)


def _sort_session_list_row(row: SessionListRow) -> tuple[int, int, str, str]:
    badge_severity = 2 if any(badge.tone == "error" for badge in row.badges) else 1 if row.badges else 0
    confidence_severity = {"error": 2, "warning": 1}.get(row.confidence_tone, 0)
    return (max(badge_severity, confidence_severity), len(row.badges), row.started_at_sort_key, row.session_id)


def _mapping(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _sequence_of_mappings(value: object) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, dict))


def _string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _number(value: object) -> float | None:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def _bool(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def _project_label(cwd: str | None, cwd_locator: str | None) -> str:
    if cwd:
        return PurePath(cwd).name or cwd
    if cwd_locator:
        return cwd_locator
    return NOT_RECORDED


def _timestamp_label(value: str | None) -> str:
    return value or NOT_RECORDED


def _duration_label(value: float | None) -> str:
    if value is None:
        return NOT_RECORDED
    if value >= 3600:
        hours = int(value // 3600)
        minutes = int((value % 3600) // 60)
        return f"{hours}h {minutes}m"
    if value >= 60:
        minutes = int(value // 60)
        seconds = int(value % 60)
        return f"{minutes}m {seconds}s"
    return f"{value:.1f}s"


def _integer_label(value: float | None) -> str:
    if value is None:
        return NOT_RECORDED
    return f"{int(value):,}"


def _currency_label(value: float | None) -> str:
    if value is None:
        return NOT_RECORDED
    return f"${value:,.4f}"


def _percent_label(value: float | None) -> str:
    if value is None:
        return NOT_RECORDED
    return f"{value:.0%}"


def _bool_label(value: bool | None) -> str:
    if value is None:
        return NOT_RECORDED
    return "Yes" if value else "No"


def _string_list_label(value: object) -> str:
    if not isinstance(value, list):
        return NOT_RECORDED
    string_values = [item for item in value if isinstance(item, str) and item]
    if not string_values:
        return "None recorded"
    return "; ".join(string_values)


def _timing_markers_label(events: Sequence[dict[str, Any]]) -> str:
    markers: list[str] = []
    for event in events:
        timestamp = _string(event.get("timestamp"))
        if timestamp is None:
            continue
        payload = _mapping(event.get("payload"))
        descriptor = (
            _string(event.get("role"))
            or _string(payload.get("kind"))
            or _string(event.get("record_kind"))
            or "event"
        )
        markers.append(f"{timestamp} · {descriptor.replace('_', ' ')}")
        if len(markers) == 3:
            break
    return " | ".join(markers) if markers else NOT_RECORDED


def _tool_names_label(tool_calls: Sequence[dict[str, Any]]) -> str:
    tool_names = sorted(
        {
            tool_name
            for tool_name in (_string(tool_call.get("tool_name")) for tool_call in tool_calls)
            if tool_name is not None
        }
    )
    return ", ".join(tool_names) if tool_names else NOT_RECORDED


def _joined_tool_links_label(tool_calls: Sequence[dict[str, Any]]) -> str:
    if not tool_calls:
        return NOT_RECORDED
    linked_count = sum(
        1
        for tool_call in tool_calls
        if _string(tool_call.get("assistant_event_id")) is not None
        and _string(tool_call.get("tool_result_event_id")) is not None
    )
    return f"{linked_count} of {len(tool_calls)} linked"


def _extraction_caveat(
    *,
    confidence_tone: str,
    is_incomplete: bool | None,
    malformed_count: float | None,
    unknown_record_count: float | None,
    warning_count: float | None,
) -> str:
    if confidence_tone == "error" or is_incomplete is True:
        return "Incomplete extraction may leave some detail partial."
    if confidence_tone == "warning" or any(value and value > 0 for value in (malformed_count, unknown_record_count, warning_count)):
        return "Warnings or unknown records may reduce confidence in fine-grained detail."
    if None in (is_incomplete, malformed_count, unknown_record_count, warning_count):
        return NOT_RECORDED
    return "No extractor caveat recorded."


def _empty_baseline_comparison(*, empty_title: str, empty_description: str) -> BaselineComparisonViewModel:
    return BaselineComparisonViewModel(
        status="empty",
        selected_session_id=NOT_RECORDED,
        selected_project_label=NOT_RECORDED,
        selected_timestamp_label=NOT_RECORDED,
        baseline_session_id=NOT_RECORDED,
        baseline_project_label=NOT_RECORDED,
        baseline_timestamp_label=NOT_RECORDED,
        choice_path_note="",
        fit_label="",
        fit_tone="muted",
        fit_note="",
        caveats=(),
        candidates=(),
        metrics=(),
        empty_title=empty_title,
        empty_description=empty_description,
    )


@dataclass(frozen=True)
class _ComparisonCandidate:
    export: SessionExport
    row: SessionListRow
    view_model: ComparisonCandidateViewModel
    rank_sort_key: _CandidateScore


def _build_comparison_candidate(
    selected_export: SessionExport,
    candidate_export: SessionExport,
    row_by_session_id: dict[str, SessionListRow],
) -> _ComparisonCandidate:
    candidate_row = row_by_session_id[candidate_export.session_id]
    selected_cwd = _string(_mapping(selected_export.payload.get("session")).get("cwd"))
    candidate_cwd = _string(_mapping(candidate_export.payload.get("session")).get("cwd"))
    same_project = bool(selected_cwd and candidate_cwd and selected_cwd == candidate_cwd)
    selected_started = _parse_timestamp(selected_export.started_at)
    candidate_started = _parse_timestamp(candidate_export.started_at)
    time_gap_seconds = (
        abs((selected_started - candidate_started).total_seconds())
        if selected_started is not None and candidate_started is not None
        else 10**12
    )
    health_rank = _health_rank(candidate_row.confidence_tone)
    rank_note = _candidate_rank_note(
        same_project=same_project,
        confidence_tone=candidate_row.confidence_tone,
        time_gap_seconds=time_gap_seconds,
    )
    return _ComparisonCandidate(
        export=candidate_export,
        row=candidate_row,
        view_model=ComparisonCandidateViewModel(
            session_id=candidate_export.session_id,
            project_label=candidate_row.project_label,
            timestamp_label=candidate_row.timestamp_label,
            rank_note=rank_note,
            choice_label=f"--baseline-session-id {candidate_export.session_id}",
            choice_note="Rerender the dashboard with this explicit baseline choice.",
            is_selected=False,
        ),
        rank_sort_key=_CandidateScore(
            same_project=0 if same_project else 1,
            health_rank=health_rank,
            time_gap_seconds=time_gap_seconds,
            started_at_sort_key=candidate_export.started_at or "",
            session_id=candidate_export.session_id,
        ),
    )


def _mark_selected_candidate(
    candidate: ComparisonCandidateViewModel,
    baseline_session_id: str,
) -> ComparisonCandidateViewModel:
    return ComparisonCandidateViewModel(
        session_id=candidate.session_id,
        project_label=candidate.project_label,
        timestamp_label=candidate.timestamp_label,
        rank_note=candidate.rank_note,
        choice_label=candidate.choice_label,
        choice_note=candidate.choice_note,
        is_selected=candidate.session_id == baseline_session_id,
    )


def _candidate_rank_note(*, same_project: bool, confidence_tone: str, time_gap_seconds: float) -> str:
    project_note = "same project" if same_project else "project differs or is unknown"
    health_note = {
        "ok": "clean extraction",
        "warning": "warning-bearing extraction",
        "error": "incomplete extraction",
    }.get(confidence_tone, "extraction health incomplete")
    time_note = (
        _time_gap_label(time_gap_seconds)
        if time_gap_seconds < 10**12
        else "time gap unknown"
    )
    return f"{project_note}; {health_note}; {time_note}"


def _build_comparison_metrics(
    selected_export: SessionExport,
    baseline_export: SessionExport,
) -> tuple[ComparisonMetricViewModel, ...]:
    selected_metrics = _mapping(selected_export.payload.get("metrics"))
    baseline_metrics = _mapping(baseline_export.payload.get("metrics"))
    return tuple(
        _comparison_metric(
            label=label,
            selected_value=_number(selected_metrics.get(metric_key)),
            baseline_value=_number(baseline_metrics.get(metric_key)),
            value_kind=value_kind,
            semantic=semantic,
            note=note,
        )
        for label, metric_key, value_kind, semantic, note in (
            ("Duration", "session_duration_seconds", "duration", "lower_better", "Lower is usually better for this metric."),
            ("Billed tokens", "total_billed_tokens", "integer", "neutral", "Token volume is directional only; it is not a quality verdict."),
            ("Cost", "total_cost", "currency", "lower_better", "Rendered from metrics.total_cost on both sides."),
            ("Tool success rate", "tool_success_rate", "percent", "higher_better", "Higher means a larger share of completed tool results succeeded."),
            ("Error→Retry count", "error_then_retry_count", "integer", "lower_better", "Lower means fewer observed error-then-retry sequences."),
            ("Time to first tool call", "time_to_first_tool_call_seconds", "duration", "lower_better", "Not recorded when a linked tool-call timestamp is missing."),
        )
    )


def _comparison_metric(
    *,
    label: str,
    selected_value: float | None,
    baseline_value: float | None,
    value_kind: str,
    semantic: str,
    note: str,
) -> ComparisonMetricViewModel:
    if selected_value is None or baseline_value is None:
        return ComparisonMetricViewModel(
            label=label,
            selected_value=_format_metric_value(selected_value, value_kind),
            baseline_value=_format_metric_value(baseline_value, value_kind),
            absolute_delta=NOT_RECORDED,
            percent_delta=NOT_RECORDED,
            direction_label=NOT_RECORDED,
            tone="muted",
            bar_width=0,
            note=note,
        )

    delta = selected_value - baseline_value
    percent_delta = _percent_delta_label(selected_value, baseline_value)
    direction_label, tone = _delta_direction(delta, semantic)
    return ComparisonMetricViewModel(
        label=label,
        selected_value=_format_metric_value(selected_value, value_kind),
        baseline_value=_format_metric_value(baseline_value, value_kind),
        absolute_delta=_format_delta(delta, value_kind),
        percent_delta=percent_delta,
        direction_label=direction_label,
        tone=tone,
        bar_width=_delta_bar_width(delta, baseline_value),
        note=note,
    )


def _format_metric_value(value: float | None, value_kind: str) -> str:
    if value_kind == "duration":
        return _duration_label(value)
    if value_kind == "currency":
        return _currency_label(value)
    if value_kind == "percent":
        return _percent_label(value)
    return _integer_label(value)


def _format_delta(delta: float, value_kind: str) -> str:
    sign = "+" if delta > 0 else "-" if delta < 0 else "±"
    magnitude = abs(delta)
    if value_kind == "duration":
        return f"{sign}{_duration_label(magnitude)}"
    if value_kind == "currency":
        return f"{sign}${magnitude:,.4f}"
    if value_kind == "percent":
        return f"{sign}{magnitude * 100:.0f} pp"
    return f"{sign}{int(magnitude):,}"


def _percent_delta_label(selected_value: float, baseline_value: float) -> str:
    if baseline_value == 0:
        return NOT_RECORDED
    return f"{((selected_value - baseline_value) / baseline_value):+.0%}"


def _delta_direction(delta: float, semantic: str) -> tuple[str, str]:
    if delta == 0:
        return ("Flat vs baseline", "neutral")
    if semantic == "higher_better":
        return (("Higher than baseline", "positive") if delta > 0 else ("Lower than baseline", "negative"))
    if semantic == "lower_better":
        return (("Lower than baseline", "positive") if delta < 0 else ("Higher than baseline", "negative"))
    return (("Higher than baseline", "neutral") if delta > 0 else ("Lower than baseline", "neutral"))


def _delta_bar_width(delta: float, baseline_value: float) -> int:
    if delta == 0:
        return 0
    if baseline_value == 0:
        return 100
    return min(100, max(8, int(abs(delta / baseline_value) * 100)))


def _comparison_fit(
    selected_export: SessionExport,
    baseline_export: SessionExport,
    selected_row: SessionListRow,
    baseline_row: SessionListRow,
) -> tuple[str, str, str]:
    same_project = _same_project(selected_export, baseline_export)
    health_differs = selected_row.confidence_tone != baseline_row.confidence_tone
    time_gap_seconds = _time_gap_seconds(selected_export.started_at, baseline_export.started_at)
    if same_project and not health_differs and time_gap_seconds is not None and time_gap_seconds <= 86400:
        return (
            "Cautious fit",
            "cautious",
            "Same project and nearby timestamps make this the best available comparison, but task similarity/source/config are still unknown.",
        )
    return (
        "Inconclusive fit",
        "inconclusive",
        "Read these deltas as directional only. Project context, extraction health, or timing may reduce comparability.",
    )


def _comparison_caveats(
    selected_export: SessionExport,
    baseline_export: SessionExport,
    selected_row: SessionListRow,
    baseline_row: SessionListRow,
) -> tuple[str, ...]:
    caveats = [
        "Task similarity unknown — metrics may not be directly comparable.",
        "Source unknown in the current Module 1 contract — same-source ranking is unavailable.",
        "Config version unknown in the current Module 1 contract — config-fit cannot be verified.",
    ]
    if not _same_project(selected_export, baseline_export):
        caveats.append("Project context differs or is unverified — treat deltas as weaker evidence.")
    if (
        selected_row.confidence_tone != baseline_row.confidence_tone
        or selected_row.confidence_tone != "ok"
        or baseline_row.confidence_tone != "ok"
    ):
        caveats.append("Extraction health differs — deltas may reflect parser confidence, not session behavior.")
    return tuple(caveats)


def _same_project(selected_export: SessionExport, baseline_export: SessionExport) -> bool:
    selected_cwd = _string(_mapping(selected_export.payload.get("session")).get("cwd"))
    baseline_cwd = _string(_mapping(baseline_export.payload.get("session")).get("cwd"))
    return bool(selected_cwd and baseline_cwd and selected_cwd == baseline_cwd)


def _time_gap_seconds(selected_started_at: str | None, baseline_started_at: str | None) -> float | None:
    selected_started = _parse_timestamp(selected_started_at)
    baseline_started = _parse_timestamp(baseline_started_at)
    if selected_started is None or baseline_started is None:
        return None
    return abs((selected_started - baseline_started).total_seconds())


def _parse_timestamp(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _health_rank(confidence_tone: str) -> int:
    return {"ok": 0, "warning": 1, "error": 2}.get(confidence_tone, 3)


def _time_gap_label(time_gap_seconds: float) -> str:
    if time_gap_seconds < 3600:
        return f"{int(time_gap_seconds // 60)}m apart"
    if time_gap_seconds < 86400:
        return f"{int(time_gap_seconds // 3600)}h apart"
    return f"{int(time_gap_seconds // 86400)}d apart"
