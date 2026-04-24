from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from self_evolve.extractor.models import (
    EventStatus,
    ExtractedSession,
    ExtractionWarning,
    LinkedSubagent,
    NormalizedEvent,
    SessionMetadata,
    SidechainLink,
    SidechainMessage,
    SidechainStatus,
    SubagentSummary,
    ToolCallJoin,
    WarningCode,
    WarningScope,
    WarningSeverity,
)

SidechainPathResolver = Callable[[str, Path], Path | None]


class _ParserState:
    def __init__(self, source_path: Path) -> None:
        self.source_path = source_path.resolve()
        self.session_id = self.source_path.stem
        self.cwd_locator = self.source_path.parent.name or None
        self.metadata = SessionMetadata(
            session_id=self.session_id,
            source_path=str(self.source_path),
            cwd_locator=self.cwd_locator,
        )
        self.events: list[NormalizedEvent] = []
        self.warnings: list[ExtractionWarning] = []
        self.tool_calls: dict[str, ToolCallJoin] = {}
        self.subagents: dict[str, LinkedSubagent] = {}
        self._assistant_tool_call_ids: set[str] = set()
        self._tool_result_ids: set[str] = set()

    def add_warning(
        self,
        warning_code: WarningCode,
        *,
        scope: WarningScope,
        message: str,
        severity: WarningSeverity = WarningSeverity.WARNING,
        line_number: int | None = None,
        event_id: str | None = None,
        subagent_id: str | None = None,
        raw_line: str | None = None,
    ) -> None:
        self.warnings.append(
            ExtractionWarning(
                warning_code=warning_code,
                severity=severity,
                scope=scope,
                message=message,
                line_number=line_number,
                event_id=event_id,
                subagent_id=subagent_id,
                raw_line=raw_line,
            )
        )


def parse_parent_session(
    session_path: str | Path,
    *,
    sidechain_path_resolver: SidechainPathResolver | None = None,
) -> ExtractedSession:
    source_path = Path(session_path)
    state = _ParserState(source_path)

    with source_path.open("r", encoding="utf-8") as handle:
        state.metadata.line_counts["total"] = sum(1 for _ in handle)

    with source_path.open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            stripped = raw_line.rstrip("\n")
            if not stripped.strip():
                continue
            try:
                record = json.loads(stripped)
            except json.JSONDecodeError:
                _handle_bad_json_line(state, stripped, line_number)
                continue
            if not isinstance(record, dict):
                state.metadata.line_counts["malformed"] += 1
                state.add_warning(
                    WarningCode.MALFORMED_JSON_LINE,
                    scope=WarningScope.PARENT_SESSION,
                    line_number=line_number,
                    message=f"Line {line_number} is not a JSON object and was skipped.",
                    raw_line=stripped,
                )
                continue

            sequence = len(state.events)
            event = _normalize_record(state, record, sequence, line_number)
            state.metadata.line_counts["parsed"] += 1
            state.events.append(event)
            _update_metadata_from_event(state, record)

    _finalize_tool_calls(state)
    _finalize_subagents(state, sidechain_path_resolver)
    _sort_warnings(state)
    extracted = ExtractedSession(
        session=state.metadata,
        events=state.events,
        tool_calls=list(state.tool_calls.values()),
        subagents=sorted(state.subagents.values(), key=lambda item: item.subagent_id),
        warnings=state.warnings,
    )
    extracted.metrics.assistant_message_count = sum(
        1
        for event in extracted.events
        if event.record_kind == "message" and event.payload.get("kind") == "message_assistant"
    )
    extracted.metrics.user_message_count = sum(
        1
        for event in extracted.events
        if event.record_kind == "message" and event.payload.get("kind") == "message_user"
    )
    extracted.metrics.tool_result_count = sum(
        1
        for event in extracted.events
        if event.record_kind == "message" and event.payload.get("kind") == "message_tool_result"
    )
    extracted.metrics.tool_call_count = len(extracted.tool_calls)
    extracted.metrics.tool_error_count = sum(1 for join in extracted.tool_calls if join.is_error)
    extracted.metrics.unknown_record_count = state.metadata.line_counts["unknown"]
    extracted.metrics.warning_count = len(extracted.warnings)
    extracted.metrics.subagent_count = len(extracted.subagents)
    return extracted


def _handle_bad_json_line(state: _ParserState, raw_line: str, line_number: int) -> None:
    is_last_line = line_number == state.metadata.line_counts["total"]
    if is_last_line and _looks_truncated(raw_line):
        state.metadata.is_incomplete = True
        _append_incomplete_reason(state.metadata, WarningCode.TRUNCATED_FINAL_LINE.value)
        state.add_warning(
            WarningCode.TRUNCATED_FINAL_LINE,
            scope=WarningScope.PARENT_SESSION,
            line_number=line_number,
            message=f"Line {line_number} appears truncated at end of file.",
            raw_line=raw_line,
        )
        return

    state.metadata.line_counts["malformed"] += 1
    state.add_warning(
        WarningCode.MALFORMED_JSON_LINE,
        scope=WarningScope.PARENT_SESSION,
        line_number=line_number,
        message=f"Line {line_number} is not valid JSON and was skipped.",
        raw_line=raw_line,
    )


def _looks_truncated(raw_line: str) -> bool:
    stripped = raw_line.rstrip()
    if not stripped:
        return False
    if stripped.count("{") > stripped.count("}"):
        return True
    if stripped.count("[") > stripped.count("]"):
        return True
    return stripped[-1] not in ("}", "]", '"')


def _append_incomplete_reason(metadata: SessionMetadata, reason: str) -> None:
    if reason not in metadata.incomplete_reasons:
        metadata.incomplete_reasons.append(reason)


def _normalize_record(
    state: _ParserState,
    record: dict[str, Any],
    sequence: int,
    line_number: int,
) -> NormalizedEvent:
    record_type = record.get("type")
    if record_type == "session":
        payload = {
            "kind": "session_header",
            "pi_session_version": record.get("version"),
            "cwd": record.get("cwd"),
            "parent_session_path": record.get("parentSession"),
        }
        return _build_event(state, record, sequence, payload)

    if record_type == "model_change":
        payload = {
            "kind": "model_change",
            "provider": record.get("provider"),
            "model_id": record.get("modelId"),
        }
        return _build_event(state, record, sequence, payload)

    if record_type == "thinking_level_change":
        payload = {
            "kind": "thinking_level_change",
            "thinking_level": record.get("thinkingLevel"),
        }
        return _build_event(state, record, sequence, payload)

    if record_type == "message":
        return _normalize_message_record(state, record, sequence, line_number)

    if record_type == "custom":
        return _normalize_custom_record(state, record, sequence, line_number)

    if record_type == "custom_message":
        return _normalize_custom_message_record(state, record, sequence, line_number)

    state.metadata.line_counts["unknown"] += 1
    state.add_warning(
        WarningCode.UNKNOWN_RECORD_KIND,
        scope=WarningScope.PARENT_SESSION,
        line_number=line_number,
        event_id=_as_str(record.get("id")),
        message=f"Unsupported parent record type: {record_type!r}.",
        raw_line=json.dumps(record, separators=(",", ":"), sort_keys=True),
    )
    return _build_event(
        state,
        record,
        sequence,
        {
            "kind": "unknown",
            "unknown_type": record_type,
            "raw": record,
        },
        status=EventStatus.UNKNOWN_RECORD_KIND,
    )


def _normalize_message_record(
    state: _ParserState,
    record: dict[str, Any],
    sequence: int,
    line_number: int,
) -> NormalizedEvent:
    message = record.get("message")
    if not isinstance(message, dict):
        state.metadata.line_counts["malformed"] += 1
        state.add_warning(
            WarningCode.MALFORMED_JSON_LINE,
            scope=WarningScope.PARENT_SESSION,
            line_number=line_number,
            event_id=_as_str(record.get("id")),
            message=f"Message record at line {line_number} is missing object payload.",
            raw_line=json.dumps(record, separators=(",", ":"), sort_keys=True),
        )
        return _build_event(
            state,
            record,
            sequence,
            {"kind": "unknown", "unknown_type": "message_payload", "raw": record},
            status=EventStatus.MALFORMED_LINE,
        )

    role = _as_str(message.get("role"))
    content = message.get("content")
    blocks = _normalize_content_blocks(
        state,
        content if isinstance(content, list) else [],
        line_number=line_number,
        event_id=_as_str(record.get("id")),
    )

    if role == "user":
        payload = {"kind": "message_user", "content_blocks": blocks}
    elif role == "assistant":
        payload = {
            "kind": "message_assistant",
            "api": message.get("api"),
            "provider": message.get("provider"),
            "model": message.get("model"),
            "response_id": message.get("responseId"),
            "stop_reason": message.get("stopReason"),
            "usage": _normalize_usage(message.get("usage")),
            "content_blocks": blocks,
        }
    elif role == "toolResult":
        payload = {
            "kind": "message_tool_result",
            "tool_call_id": _as_str(message.get("toolCallId")),
            "tool_name": _as_str(message.get("toolName")),
            "is_error": bool(message.get("isError")),
            "details": message.get("details") if isinstance(message.get("details"), dict) else None,
            "content_blocks": blocks,
        }
    else:
        payload = {
            "kind": "unknown",
            "unknown_type": f"message_role:{role}",
            "raw": record,
        }
        state.metadata.line_counts["unknown"] += 1
        state.add_warning(
            WarningCode.UNKNOWN_RECORD_KIND,
            scope=WarningScope.PARENT_SESSION,
            line_number=line_number,
            event_id=_as_str(record.get("id")),
            message=f"Unsupported message role: {role!r}.",
            raw_line=json.dumps(record, separators=(",", ":"), sort_keys=True),
        )

    event = _build_event(state, record, sequence, payload, role=role)
    _capture_tool_activity(state, event)
    return event


def _normalize_custom_record(
    state: _ParserState,
    record: dict[str, Any],
    sequence: int,
    line_number: int,
) -> NormalizedEvent:
    custom_type = _as_str(record.get("customType"))
    data = record.get("data") if isinstance(record.get("data"), dict) else {}

    if custom_type == "agent-mode":
        payload = {
            "kind": "agent_mode",
            "mode": data.get("mode"),
            "plan_review_approved": data.get("planReviewApproved"),
            "plan_review_pending": data.get("planReviewPending"),
            "plan_title": data.get("planTitle"),
            "plan_title_source": data.get("planTitleSource"),
            "plan_content": data.get("planContent"),
        }
        return _build_event(state, record, sequence, payload, custom_type=custom_type)

    if custom_type == "subagents:record":
        payload = {
            "kind": "subagent_record",
            "subagent_id": _as_str(data.get("id")),
            "subagent_type": _as_str(data.get("type")),
            "description": _as_str(data.get("description")),
            "status_text": _as_str(data.get("status")),
            "result_text": _as_str(data.get("result")),
            "started_at": _epoch_millis_to_iso(data.get("startedAt")),
            "completed_at": _epoch_millis_to_iso(data.get("completedAt")),
        }
        event = _build_event(state, record, sequence, payload, custom_type=custom_type)
        _capture_subagent_record(state, event, record, line_number)
        return event

    state.metadata.line_counts["unknown"] += 1
    state.add_warning(
        WarningCode.UNKNOWN_RECORD_KIND,
        scope=WarningScope.PARENT_SESSION,
        line_number=line_number,
        event_id=_as_str(record.get("id")),
        message=f"Unsupported custom record type: {custom_type!r}.",
        raw_line=json.dumps(record, separators=(",", ":"), sort_keys=True),
    )
    return _build_event(
        state,
        record,
        sequence,
        {"kind": "unknown", "unknown_type": custom_type, "raw": record},
        custom_type=custom_type,
        status=EventStatus.UNKNOWN_RECORD_KIND,
    )


def _normalize_custom_message_record(
    state: _ParserState,
    record: dict[str, Any],
    sequence: int,
    line_number: int,
) -> NormalizedEvent:
    custom_type = _as_str(record.get("customType"))
    details = record.get("details") if isinstance(record.get("details"), dict) else {}

    if custom_type == "subagent-notification":
        payload = {
            "kind": "subagent_notification",
            "subagent_id": _as_str(details.get("id")),
            "description": _as_str(details.get("description")),
            "status_text": _as_str(details.get("status")),
            "tool_uses": _as_int(details.get("toolUses")),
            "turn_count": _as_int(details.get("turnCount")),
            "total_tokens": _as_int(details.get("totalTokens")),
            "duration_ms": _as_int(details.get("durationMs")),
            "output_file": _as_str(details.get("outputFile")),
            "result_preview": _as_str(details.get("resultPreview")),
            "display": bool(record.get("display")),
            "content": _as_str(record.get("content")),
        }
        event = _build_event(state, record, sequence, payload, custom_type=custom_type)
        _capture_subagent_notification(state, event, record, line_number)
        return event

    state.metadata.line_counts["unknown"] += 1
    state.add_warning(
        WarningCode.UNKNOWN_RECORD_KIND,
        scope=WarningScope.PARENT_SESSION,
        line_number=line_number,
        event_id=_as_str(record.get("id")),
        message=f"Unsupported custom_message type: {custom_type!r}.",
        raw_line=json.dumps(record, separators=(",", ":"), sort_keys=True),
    )
    return _build_event(
        state,
        record,
        sequence,
        {"kind": "unknown", "unknown_type": custom_type, "raw": record},
        custom_type=custom_type,
        status=EventStatus.UNKNOWN_RECORD_KIND,
    )


def _build_event(
    state: _ParserState,
    record: dict[str, Any],
    sequence: int,
    payload: dict[str, Any],
    *,
    custom_type: str | None = None,
    role: str | None = None,
    status: EventStatus = EventStatus.OK,
) -> NormalizedEvent:
    return NormalizedEvent(
        event_id=_as_str(record.get("id")),
        record_kind=_as_str(record.get("type")) or "unknown",
        custom_type=custom_type,
        parent_event_id=_as_str(record.get("parentId")),
        timestamp=_as_str(record.get("timestamp")),
        sequence=sequence,
        role=role,
        status=status,
        payload=payload,
        raw=record,
    )


def _normalize_content_blocks(
    state: _ParserState,
    content: list[Any],
    *,
    line_number: int,
    event_id: str | None,
) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for block in content:
        if not isinstance(block, dict):
            blocks.append({"block_kind": "unknown", "raw": block})
            state.add_warning(
                WarningCode.UNKNOWN_MESSAGE_BLOCK_KIND,
                scope=WarningScope.NORMALIZATION,
                line_number=line_number,
                event_id=event_id,
                message="Encountered non-object content block.",
                raw_line=json.dumps(block),
            )
            continue

        block_type = block.get("type")
        if block_type == "text":
            blocks.append(
                {
                    "block_kind": "text",
                    "text": _as_str(block.get("text")),
                    "signature": _as_str(block.get("textSignature")),
                }
            )
            continue
        if block_type == "thinking":
            blocks.append(
                {
                    "block_kind": "thinking",
                    "thinking": _as_str(block.get("thinking")),
                    "signature": _as_str(block.get("thinkingSignature")),
                }
            )
            continue
        if block_type == "toolCall":
            arguments = block.get("arguments")
            blocks.append(
                {
                    "block_kind": "tool_call",
                    "tool_call_id": _as_str(block.get("id")),
                    "tool_name": _as_str(block.get("name")),
                    "arguments": arguments if isinstance(arguments, dict) else None,
                }
            )
            continue

        blocks.append({"block_kind": "unknown", "raw": block})
        state.add_warning(
            WarningCode.UNKNOWN_MESSAGE_BLOCK_KIND,
            scope=WarningScope.NORMALIZATION,
            line_number=line_number,
            event_id=event_id,
            message=f"Unsupported message content block type: {block_type!r}.",
            raw_line=json.dumps(block, separators=(",", ":"), sort_keys=True),
        )
    return blocks


def _normalize_usage(raw_usage: Any) -> dict[str, Any]:
    usage = raw_usage if isinstance(raw_usage, dict) else {}
    cost = usage.get("cost") if isinstance(usage.get("cost"), dict) else {}
    return {
        "input_tokens": _as_int(usage.get("input")) or 0,
        "output_tokens": _as_int(usage.get("output")) or 0,
        "cache_read_tokens": _as_int(usage.get("cacheRead")) or 0,
        "cache_write_tokens": _as_int(usage.get("cacheWrite")) or 0,
        "total_tokens": _as_int(usage.get("totalTokens")) or 0,
        "cost_input": _as_float(cost.get("input")) or 0.0,
        "cost_output": _as_float(cost.get("output")) or 0.0,
        "cost_cache_read": _as_float(cost.get("cacheRead")) or 0.0,
        "cost_cache_write": _as_float(cost.get("cacheWrite")) or 0.0,
        "cost_total": _as_float(cost.get("total")) or 0.0,
    }


def _capture_tool_activity(state: _ParserState, event: NormalizedEvent) -> None:
    payload = event.payload
    if payload.get("kind") == "message_assistant":
        for block in payload.get("content_blocks", []):
            if block.get("block_kind") != "tool_call":
                continue
            tool_call_id = _as_str(block.get("tool_call_id"))
            tool_name = _as_str(block.get("tool_name"))
            if not tool_call_id or not tool_name:
                continue
            state._assistant_tool_call_ids.add(tool_call_id)
            state.tool_calls[tool_call_id] = ToolCallJoin(
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                session_id=state.metadata.session_id,
                assistant_event_id=event.event_id,
                arguments=block.get("arguments") if isinstance(block.get("arguments"), dict) else None,
            )
        return

    if payload.get("kind") == "message_tool_result":
        tool_call_id = _as_str(payload.get("tool_call_id"))
        tool_name = _as_str(payload.get("tool_name"))
        if not tool_call_id or not tool_name:
            return
        join = state.tool_calls.get(tool_call_id)
        if join is None:
            join = ToolCallJoin(
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                session_id=state.metadata.session_id,
            )
            state.tool_calls[tool_call_id] = join
        join.tool_result_event_id = event.event_id
        join.is_error = bool(payload.get("is_error"))
        join.result_details = payload.get("details") if isinstance(payload.get("details"), dict) else None
        join.result_text = _extract_text_from_blocks(payload.get("content_blocks", []))
        state._tool_result_ids.add(tool_call_id)


def _finalize_tool_calls(state: _ParserState) -> None:
    for tool_call_id, join in state.tool_calls.items():
        if tool_call_id in state._assistant_tool_call_ids and tool_call_id not in state._tool_result_ids:
            state.add_warning(
                WarningCode.UNMATCHED_TOOL_CALL,
                scope=WarningScope.NORMALIZATION,
                event_id=join.assistant_event_id,
                message=f"Tool call {tool_call_id} has no matching tool result.",
            )
        if tool_call_id in state._tool_result_ids and tool_call_id not in state._assistant_tool_call_ids:
            state.add_warning(
                WarningCode.UNMATCHED_TOOL_RESULT,
                scope=WarningScope.NORMALIZATION,
                event_id=join.tool_result_event_id,
                message=f"Tool result {tool_call_id} has no matching assistant tool call.",
            )


def _capture_subagent_record(
    state: _ParserState,
    event: NormalizedEvent,
    record: dict[str, Any],
    line_number: int,
) -> None:
    payload = event.payload
    subagent_id = _as_str(payload.get("subagent_id"))
    if not subagent_id:
        return
    linked = _get_or_create_subagent(state, subagent_id)
    if linked.summary.record_event_id is not None:
        state.add_warning(
            WarningCode.DUPLICATE_SUBAGENT_SUMMARY,
            scope=WarningScope.NORMALIZATION,
            line_number=line_number,
            event_id=event.event_id,
            subagent_id=subagent_id,
            message=f"Duplicate subagent record for {subagent_id}.",
            raw_line=json.dumps(record, separators=(",", ":"), sort_keys=True),
        )
    linked.subagent_type = _as_str(payload.get("subagent_type")) or linked.subagent_type
    linked.description = _as_str(payload.get("description")) or linked.description
    linked.status_text = _as_str(payload.get("status_text")) or linked.status_text
    linked.summary.record_event_id = event.event_id
    linked.summary.result_text = _as_str(payload.get("result_text"))
    linked.summary.started_at = _as_str(payload.get("started_at"))
    linked.summary.completed_at = _as_str(payload.get("completed_at"))
    linked.raw_evidence["record"] = record

    path_hint = _extract_transcript_path(linked.summary.result_text)
    if path_hint and linked.sidechain.path_hint is None:
        linked.sidechain.path_hint = path_hint


def _capture_subagent_notification(
    state: _ParserState,
    event: NormalizedEvent,
    record: dict[str, Any],
    line_number: int,
) -> None:
    payload = event.payload
    subagent_id = _as_str(payload.get("subagent_id"))
    if not subagent_id:
        return
    linked = _get_or_create_subagent(state, subagent_id)
    if linked.summary.notification_event_id is not None:
        state.add_warning(
            WarningCode.DUPLICATE_SUBAGENT_SUMMARY,
            scope=WarningScope.NORMALIZATION,
            line_number=line_number,
            event_id=event.event_id,
            subagent_id=subagent_id,
            message=f"Duplicate subagent notification for {subagent_id}.",
            raw_line=json.dumps(record, separators=(",", ":"), sort_keys=True),
        )
    linked.description = _as_str(payload.get("description")) or linked.description
    linked.status_text = _as_str(payload.get("status_text")) or linked.status_text
    linked.summary.notification_event_id = event.event_id
    linked.summary.result_preview = _as_str(payload.get("result_preview"))
    linked.summary.tool_uses = _as_int(payload.get("tool_uses"))
    linked.summary.turn_count = _as_int(payload.get("turn_count"))
    linked.summary.total_tokens = _as_int(payload.get("total_tokens"))
    linked.summary.duration_ms = _as_int(payload.get("duration_ms"))
    output_file = _as_str(payload.get("output_file"))
    if output_file:
        linked.sidechain.path_hint = output_file
    linked.raw_evidence["notification"] = record


def _get_or_create_subagent(state: _ParserState, subagent_id: str) -> LinkedSubagent:
    linked = state.subagents.get(subagent_id)
    if linked is None:
        linked = LinkedSubagent(
            subagent_id=subagent_id,
            summary=SubagentSummary(),
            sidechain=SidechainLink(status=SidechainStatus.NOT_REFERENCED),
            raw_evidence={},
        )
        state.subagents[subagent_id] = linked
    return linked


def _finalize_subagents(
    state: _ParserState,
    sidechain_path_resolver: SidechainPathResolver | None,
) -> None:
    for linked in state.subagents.values():
        if not linked.sidechain.path_hint:
            linked.sidechain.status = SidechainStatus.NOT_REFERENCED
            continue

        linked.sidechain.status = SidechainStatus.MISSING
        resolved = _resolve_sidechain_path(
            linked.sidechain.path_hint,
            state.source_path,
            sidechain_path_resolver,
        )
        if resolved is None or not resolved.is_file():
            state.add_warning(
                WarningCode.MISSING_SIDECHAIN_FILE,
                scope=WarningScope.SIDCHAIN,
                subagent_id=linked.subagent_id,
                message=f"Sidechain file is missing for subagent {linked.subagent_id}.",
                raw_line=linked.sidechain.path_hint,
            )
            continue

        linked.sidechain.resolved_path = str(resolved)
        parsed_messages, had_warning = _parse_sidechain_file(state, linked.subagent_id, resolved)
        linked.sidechain.messages = parsed_messages
        linked.sidechain.record_count = len(parsed_messages)
        linked.sidechain.status = (
            SidechainStatus.PARSE_WARNING if had_warning else SidechainStatus.PRESENT
        )


def _resolve_sidechain_path(
    path_hint: str,
    session_path: Path,
    resolver: SidechainPathResolver | None,
) -> Path | None:
    if resolver is not None:
        resolved = resolver(path_hint, session_path)
        if resolved is not None:
            return resolved
    return Path(path_hint)


def _parse_sidechain_file(
    state: _ParserState,
    subagent_id: str,
    path: Path,
) -> tuple[list[SidechainMessage], bool]:
    messages: list[SidechainMessage] = []
    had_warning = False
    with path.open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            stripped = raw_line.rstrip("\n")
            if not stripped.strip():
                continue
            try:
                record = json.loads(stripped)
            except json.JSONDecodeError:
                had_warning = True
                state.add_warning(
                    WarningCode.SIDECHAIN_PARSE_WARNING,
                    scope=WarningScope.SIDCHAIN,
                    line_number=line_number,
                    subagent_id=subagent_id,
                    message=f"Sidechain line {line_number} is not valid JSON.",
                    raw_line=stripped,
                )
                continue
            if not isinstance(record, dict):
                had_warning = True
                state.add_warning(
                    WarningCode.SIDECHAIN_PARSE_WARNING,
                    scope=WarningScope.SIDCHAIN,
                    line_number=line_number,
                    subagent_id=subagent_id,
                    message=f"Sidechain line {line_number} is not a JSON object.",
                    raw_line=stripped,
                )
                continue
            wrapper_type = _as_str(record.get("type"))
            message = record.get("message") if isinstance(record.get("message"), dict) else {}
            messages.append(
                SidechainMessage(
                    sequence=len(messages),
                    type=wrapper_type or "unknown",
                    timestamp=_as_str(record.get("timestamp")),
                    role=_as_str(message.get("role")),
                    raw=record,
                )
            )
    return messages, had_warning


def _update_metadata_from_event(state: _ParserState, record: dict[str, Any]) -> None:
    timestamp = _as_str(record.get("timestamp"))
    if timestamp and (state.metadata.ended_at is None or timestamp > state.metadata.ended_at):
        state.metadata.ended_at = timestamp

    if record.get("type") == "session":
        state.metadata.session_id = _as_str(record.get("id")) or state.metadata.session_id
        state.metadata.cwd = _as_str(record.get("cwd"))
        state.metadata.parent_session_path = _as_str(record.get("parentSession"))
        state.metadata.started_at = timestamp
        state.metadata.pi_session_version = _as_int(record.get("version"))


def _sort_warnings(state: _ParserState) -> None:
    state.warnings.sort(
        key=lambda warning: (
            warning.scope.value,
            warning.line_number if warning.line_number is not None else -1,
            warning.warning_code.value,
            warning.subagent_id or "",
        )
    )


def _extract_text_from_blocks(blocks: Any) -> str | None:
    if not isinstance(blocks, list):
        return None
    texts = [block.get("text") for block in blocks if isinstance(block, dict) and block.get("block_kind") == "text"]
    joined = "\n".join(text for text in texts if isinstance(text, str) and text)
    return joined or None


def _extract_transcript_path(result_text: str | None) -> str | None:
    if not result_text:
        return None
    marker = "Transcript file:"
    for line in result_text.splitlines():
        if marker in line:
            return line.split(marker, maxsplit=1)[1].strip() or None
    return None


def _epoch_millis_to_iso(value: Any) -> str | None:
    millis = _as_int(value)
    if millis is None:
        return None
    return datetime.fromtimestamp(millis / 1000, tz=UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _as_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _as_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None
