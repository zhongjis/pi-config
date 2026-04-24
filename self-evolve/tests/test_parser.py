from __future__ import annotations

from pathlib import Path

from self_evolve.extractor.models import SidechainStatus, WarningCode
from self_evolve.extractor.parser import parse_parent_session


def test_parse_parent_clean_fixture(clean_parent_fixture: Path) -> None:
    extracted = parse_parent_session(clean_parent_fixture)

    assert extracted.session.session_id == "session-parent-clean"
    assert extracted.session.started_at == "2026-04-23T10:00:00.000Z"
    assert extracted.session.ended_at == "2026-04-23T10:00:03.000Z"
    assert extracted.session.is_incomplete is False
    assert extracted.session.line_counts == {
        "total": 8,
        "parsed": 8,
        "malformed": 0,
        "unknown": 0,
    }

    assert [event.payload["kind"] for event in extracted.events] == [
        "session_header",
        "model_change",
        "thinking_level_change",
        "agent_mode",
        "message_user",
        "message_assistant",
        "message_tool_result",
        "message_assistant",
    ]

    assert len(extracted.tool_calls) == 1
    assert extracted.tool_calls[0].tool_call_id == "call-read-1|fc-1"
    assert extracted.tool_calls[0].assistant_event_id == "msg-assistant-1"
    assert extracted.tool_calls[0].tool_result_event_id == "msg-tool-1"
    assert extracted.tool_calls[0].arguments == {"path": "/home/example/project/README.md"}
    assert extracted.tool_calls[0].result_text == "1#AA:Sample README line"

    assert extracted.subagents == []
    assert extracted.warnings == []


def test_parse_parent_malformed_and_truncated_fixture(
    malformed_parent_fixture: Path,
) -> None:
    extracted = parse_parent_session(malformed_parent_fixture)

    assert extracted.session.session_id == "session-parent-bad"
    assert extracted.session.is_incomplete is True
    assert extracted.session.incomplete_reasons == ["truncated_final_line"]
    assert extracted.session.line_counts == {
        "total": 4,
        "parsed": 2,
        "malformed": 1,
        "unknown": 0,
    }

    assert [warning.warning_code for warning in extracted.warnings] == [
        WarningCode.MALFORMED_JSON_LINE,
        WarningCode.TRUNCATED_FINAL_LINE,
    ]
    assert extracted.warnings[0].line_number == 3
    assert extracted.warnings[1].line_number == 4

    assert len(extracted.events) == 2
    assert extracted.events[0].payload["kind"] == "session_header"
    assert extracted.events[1].payload["kind"] == "message_user"
    assert extracted.tool_calls == []


def test_parse_parent_with_sidechain_present(
    sidechain_parent_fixture: Path,
    sidechain_output_fixture: Path,
) -> None:
    extracted = parse_parent_session(
        sidechain_parent_fixture,
        sidechain_path_resolver=lambda _hint, _session_path: sidechain_output_fixture,
    )

    assert extracted.session.session_id == "session-parent-sidechain"
    assert extracted.session.parent_session_path == "/home/example/project/sessions/previous.jsonl"
    assert extracted.session.line_counts == {
        "total": 11,
        "parsed": 11,
        "malformed": 0,
        "unknown": 0,
    }

    assert len(extracted.tool_calls) == 2
    assert [join.tool_call_id for join in extracted.tool_calls] == [
        "call-agent-1|fc-2",
        "call-get-subagent-1|fc-3",
    ]
    assert extracted.tool_calls[0].tool_result_event_id == "msg-tool-2"
    assert extracted.tool_calls[1].tool_result_event_id == "msg-tool-3"

    assert len(extracted.subagents) == 1
    subagent = extracted.subagents[0]
    assert subagent.subagent_id == "agent-side-1"
    assert subagent.subagent_type == "chengfeng"
    assert subagent.description == "Inspect fixtures"
    assert subagent.status_text == "completed"
    assert subagent.summary.record_event_id == "custom-subagent-1"
    assert subagent.summary.notification_event_id == "custom-message-1"
    assert subagent.summary.result_preview == "Synthetic sanitized summary."
    assert subagent.sidechain.status == SidechainStatus.PRESENT
    assert subagent.sidechain.record_count == 2
    assert [message.type for message in subagent.sidechain.messages] == ["user", "assistant"]
    assert [message.role for message in subagent.sidechain.messages] == ["user", "assistant"]
    assert subagent.raw_evidence["record"]["type"] == "custom"
    assert subagent.raw_evidence["notification"]["type"] == "custom_message"
    assert extracted.warnings == []


def test_parse_parent_with_sidechain_missing_is_non_fatal(
    sidechain_parent_fixture: Path,
) -> None:
    extracted = parse_parent_session(sidechain_parent_fixture)

    assert len(extracted.subagents) == 1
    subagent = extracted.subagents[0]
    assert subagent.sidechain.status == SidechainStatus.MISSING
    assert subagent.sidechain.path_hint == (
        "/tmp/pi-subagents-1000/home-example-project/"
        "session-parent-sidechain/tasks/agent-side-1.output"
    )
    assert subagent.sidechain.resolved_path is None
    assert subagent.sidechain.record_count == 0
    assert subagent.raw_evidence["record"]["data"]["id"] == "agent-side-1"
    assert subagent.raw_evidence["notification"]["details"]["id"] == "agent-side-1"

    assert [warning.warning_code for warning in extracted.warnings] == [
        WarningCode.MISSING_SIDECHAIN_FILE,
    ]
    assert extracted.warnings[0].subagent_id == "agent-side-1"
