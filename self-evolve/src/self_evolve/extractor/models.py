"""Stable Module 1 extractor model stubs.

These types define the target normalized shapes for later parser and persistence work.
They intentionally avoid parser implementation logic.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any


SCHEMA_VERSION = 1


class EventStatus(StrEnum):
    OK = "ok"
    UNKNOWN_RECORD_KIND = "unknown_record_kind"
    MALFORMED_LINE = "malformed_line"
    TRUNCATED_INPUT = "truncated_input"


class SidechainStatus(StrEnum):
    PRESENT = "present"
    MISSING = "missing"
    NOT_REFERENCED = "not_referenced"
    PARSE_WARNING = "parse_warning"
    UNSUPPORTED = "unsupported"


class WarningSeverity(StrEnum):
    WARNING = "warning"
    ERROR = "error"


class WarningScope(StrEnum):
    PARENT_SESSION = "parent_session"
    SIDCHAIN = "sidechain"
    NORMALIZATION = "normalization"
    PERSISTENCE = "persistence"


class WarningCode(StrEnum):
    MALFORMED_JSON_LINE = "malformed_json_line"
    TRUNCATED_FINAL_LINE = "truncated_final_line"
    UNKNOWN_RECORD_KIND = "unknown_record_kind"
    UNKNOWN_MESSAGE_BLOCK_KIND = "unknown_message_block_kind"
    MISSING_SIDECHAIN_FILE = "missing_sidechain_file"
    SIDECHAIN_PARSE_WARNING = "sidechain_parse_warning"
    DUPLICATE_SUBAGENT_SUMMARY = "duplicate_subagent_summary"
    UNMATCHED_TOOL_CALL = "unmatched_tool_call"
    UNMATCHED_TOOL_RESULT = "unmatched_tool_result"


@dataclass(slots=True)
class UsageSummary:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    total_tokens: int = 0
    cost_input: float = 0.0
    cost_output: float = 0.0
    cost_cache_read: float = 0.0
    cost_cache_write: float = 0.0
    cost_total: float = 0.0


@dataclass(slots=True)
class ContentBlock:
    block_kind: str
    raw: dict[str, Any] = field(default_factory=dict)
    text: str | None = None
    thinking: str | None = None
    signature: str | None = None
    tool_call_id: str | None = None
    tool_name: str | None = None
    arguments: dict[str, Any] | None = None


@dataclass(slots=True)
class SessionMetadata:
    session_id: str
    source_path: str
    source_kind: str = "parent_session_jsonl"
    cwd: str | None = None
    cwd_locator: str | None = None
    parent_session_path: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    schema_version: int = SCHEMA_VERSION
    pi_session_version: int | None = None
    is_incomplete: bool = False
    incomplete_reasons: list[str] = field(default_factory=list)
    line_counts: dict[str, int] = field(
        default_factory=lambda: {
            "total": 0,
            "parsed": 0,
            "malformed": 0,
            "unknown": 0,
        }
    )


@dataclass(slots=True)
class NormalizedEvent:
    event_id: str | None
    record_kind: str
    sequence: int
    timestamp: str | None
    payload: dict[str, Any]
    raw: dict[str, Any] = field(default_factory=dict)
    custom_type: str | None = None
    parent_event_id: str | None = None
    role: str | None = None
    status: EventStatus = EventStatus.OK


@dataclass(slots=True)
class ToolCallJoin:
    tool_call_id: str
    tool_name: str
    session_id: str
    assistant_event_id: str | None = None
    tool_result_event_id: str | None = None
    arguments: dict[str, Any] | None = None
    is_error: bool | None = None
    result_details: dict[str, Any] | None = None
    result_text: str | None = None


@dataclass(slots=True)
class SidechainMessage:
    sequence: int
    type: str
    timestamp: str | None
    role: str | None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class SidechainLink:
    status: SidechainStatus
    path_hint: str | None = None
    resolved_path: str | None = None
    record_count: int = 0
    messages: list[SidechainMessage] = field(default_factory=list)


@dataclass(slots=True)
class SubagentSummary:
    record_event_id: str | None = None
    notification_event_id: str | None = None
    result_text: str | None = None
    result_preview: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    tool_uses: int | None = None
    turn_count: int | None = None
    total_tokens: int | None = None
    duration_ms: int | None = None


@dataclass(slots=True)
class LinkedSubagent:
    subagent_id: str
    summary: SubagentSummary
    sidechain: SidechainLink
    raw_evidence: dict[str, Any] = field(default_factory=dict)
    subagent_type: str | None = None
    description: str | None = None
    status_text: str | None = None


@dataclass(slots=True)
class ExtractionWarning:
    warning_code: WarningCode
    severity: WarningSeverity
    scope: WarningScope
    message: str
    line_number: int | None = None
    event_id: str | None = None
    subagent_id: str | None = None
    raw_line: str | None = None


@dataclass(slots=True)
class SessionMetrics:
    session_duration_seconds: float | None = None
    time_to_first_tool_call_seconds: float | None = None
    assistant_message_count: int = 0
    user_message_count: int = 0
    tool_call_count: int = 0
    tool_result_count: int = 0
    tool_error_count: int = 0
    tool_success_rate: float | None = None
    error_then_retry_count: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_cache_read_tokens: int = 0
    total_cache_write_tokens: int = 0
    total_billed_tokens: int = 0
    total_cost: float = 0.0
    unknown_record_count: int = 0
    warning_count: int = 0
    subagent_count: int = 0


@dataclass(slots=True)
class ExtractedSession:
    session: SessionMetadata
    events: list[NormalizedEvent] = field(default_factory=list)
    tool_calls: list[ToolCallJoin] = field(default_factory=list)
    subagents: list[LinkedSubagent] = field(default_factory=list)
    metrics: SessionMetrics = field(default_factory=SessionMetrics)
    warnings: list[ExtractionWarning] = field(default_factory=list)
    schema_version: int = SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        """Return deterministic top-level ordering for durable JSON export."""

        return {
            "schema_version": self.schema_version,
            "session": asdict(self.session),
            "events": [asdict(event) for event in self.events],
            "tool_calls": [asdict(tool_call) for tool_call in self.tool_calls],
            "subagents": [asdict(subagent) for subagent in self.subagents],
            "metrics": asdict(self.metrics),
            "warnings": [asdict(warning) for warning in self.warnings],
        }
