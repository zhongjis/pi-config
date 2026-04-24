from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from self_evolve.extractor.metrics import calculate_metrics
from self_evolve.extractor.models import ExtractedSession


@dataclass(slots=True, frozen=True)
class PersistedExtraction:
    session_id: str
    export_path: Path
    sqlite_path: Path
    warning_count: int
    event_count: int
    tool_call_count: int
    subagent_count: int


_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      source_path TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      cwd TEXT,
      cwd_locator TEXT,
      parent_session_path TEXT,
      started_at TEXT,
      ended_at TEXT,
      pi_session_version INTEGER,
      is_incomplete INTEGER NOT NULL,
      incomplete_reasons_json TEXT NOT NULL,
      line_counts_json TEXT NOT NULL,
      raw_export_json TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS session_events (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_id TEXT,
      record_kind TEXT NOT NULL,
      custom_type TEXT,
      parent_event_id TEXT,
      timestamp TEXT,
      role TEXT,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      raw_json TEXT,
      PRIMARY KEY (session_id, sequence),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS session_tool_calls (
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      assistant_event_id TEXT,
      tool_result_event_id TEXT,
      is_error INTEGER,
      arguments_json TEXT,
      result_details_json TEXT,
      result_text TEXT,
      PRIMARY KEY (session_id, tool_call_id),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS session_subagents (
      session_id TEXT NOT NULL,
      subagent_id TEXT NOT NULL,
      subagent_type TEXT,
      description TEXT,
      status_text TEXT,
      summary_json TEXT NOT NULL,
      sidechain_status TEXT NOT NULL,
      sidechain_path_hint TEXT,
      sidechain_resolved_path TEXT,
      sidechain_record_count INTEGER,
      sidechain_messages_json TEXT,
      raw_evidence_json TEXT NOT NULL,
      PRIMARY KEY (session_id, subagent_id),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS session_warnings (
      session_id TEXT NOT NULL,
      warning_index INTEGER NOT NULL,
      warning_code TEXT NOT NULL,
      severity TEXT NOT NULL,
      scope TEXT NOT NULL,
      line_number INTEGER,
      event_id TEXT,
      subagent_id TEXT,
      message TEXT NOT NULL,
      raw_line TEXT,
      PRIMARY KEY (session_id, warning_index),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS session_metrics (
      session_id TEXT PRIMARY KEY,
      metrics_json TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    )
    """,
)

_CHILD_TABLES = (
    "session_events",
    "session_tool_calls",
    "session_subagents",
    "session_warnings",
    "session_metrics",
)


def persist_extracted_session(
    extracted_session: ExtractedSession,
    *,
    output_root: Path,
    sqlite_path: Path,
) -> PersistedExtraction:
    calculation = calculate_metrics(extracted_session)
    extracted_session.metrics = calculation.session_metrics

    export_payload = extracted_session.to_dict()
    raw_export_json = serialize_export_payload(export_payload)
    export_path = write_export_json(
        session_id=extracted_session.session.session_id,
        output_root=output_root,
        raw_export_json=raw_export_json,
    )
    persist_session_sqlite(
        extracted_session=extracted_session,
        sqlite_path=sqlite_path,
        raw_export_json=raw_export_json,
    )
    return PersistedExtraction(
        session_id=extracted_session.session.session_id,
        export_path=export_path,
        sqlite_path=sqlite_path,
        warning_count=len(extracted_session.warnings),
        event_count=len(extracted_session.events),
        tool_call_count=len(extracted_session.tool_calls),
        subagent_count=len(extracted_session.subagents),
    )



def serialize_export_payload(payload: dict[str, Any]) -> str:
    normalized_payload = {
        key: _normalize_for_json(value)
        for key, value in payload.items()
    }
    return json.dumps(normalized_payload, ensure_ascii=False, indent=2) + "\n"



def write_export_json(*, session_id: str, output_root: Path, raw_export_json: str) -> Path:
    export_path = output_root / f"{session_id}.json"
    export_path.write_text(raw_export_json, encoding="utf-8")
    return export_path.resolve()



def persist_session_sqlite(
    *,
    extracted_session: ExtractedSession,
    sqlite_path: Path,
    raw_export_json: str,
) -> None:
    sqlite_path.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(sqlite_path) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        for statement in _SCHEMA_STATEMENTS:
            connection.execute(statement)

        with connection:
            _migrate_session_tool_calls_primary_key(connection)
            connection.execute(
                """
                INSERT INTO sessions (
                  session_id,
                  schema_version,
                  source_path,
                  source_kind,
                  cwd,
                  cwd_locator,
                  parent_session_path,
                  started_at,
                  ended_at,
                  pi_session_version,
                  is_incomplete,
                  incomplete_reasons_json,
                  line_counts_json,
                  raw_export_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                  schema_version = excluded.schema_version,
                  source_path = excluded.source_path,
                  source_kind = excluded.source_kind,
                  cwd = excluded.cwd,
                  cwd_locator = excluded.cwd_locator,
                  parent_session_path = excluded.parent_session_path,
                  started_at = excluded.started_at,
                  ended_at = excluded.ended_at,
                  pi_session_version = excluded.pi_session_version,
                  is_incomplete = excluded.is_incomplete,
                  incomplete_reasons_json = excluded.incomplete_reasons_json,
                  line_counts_json = excluded.line_counts_json,
                  raw_export_json = excluded.raw_export_json
                """,
                (
                    extracted_session.session.session_id,
                    extracted_session.schema_version,
                    extracted_session.session.source_path,
                    extracted_session.session.source_kind,
                    extracted_session.session.cwd,
                    extracted_session.session.cwd_locator,
                    extracted_session.session.parent_session_path,
                    extracted_session.session.started_at,
                    extracted_session.session.ended_at,
                    extracted_session.session.pi_session_version,
                    int(extracted_session.session.is_incomplete),
                    _compact_json(extracted_session.session.incomplete_reasons),
                    _compact_json(extracted_session.session.line_counts),
                    raw_export_json,
                ),
            )

            for table_name in _CHILD_TABLES:
                connection.execute(
                    f"DELETE FROM {table_name} WHERE session_id = ?",
                    (extracted_session.session.session_id,),
                )

            for event in extracted_session.events:
                connection.execute(
                    """
                    INSERT INTO session_events (
                      session_id,
                      sequence,
                      event_id,
                      record_kind,
                      custom_type,
                      parent_event_id,
                      timestamp,
                      role,
                      status,
                      payload_json,
                      raw_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        extracted_session.session.session_id,
                        event.sequence,
                        event.event_id,
                        event.record_kind,
                        event.custom_type,
                        event.parent_event_id,
                        event.timestamp,
                        event.role,
                        event.status.value,
                        _compact_json(event.payload),
                        _compact_json(event.raw),
                    ),
                )

            for tool_call in extracted_session.tool_calls:
                connection.execute(
                    """
                    INSERT INTO session_tool_calls (
                      session_id,
                      tool_call_id,
                      tool_name,
                      assistant_event_id,
                      tool_result_event_id,
                      is_error,
                      arguments_json,
                      result_details_json,
                      result_text
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        extracted_session.session.session_id,
                        tool_call.tool_call_id,
                        tool_call.tool_name,
                        tool_call.assistant_event_id,
                        tool_call.tool_result_event_id,
                        _as_sqlite_bool(tool_call.is_error),
                        _compact_json(tool_call.arguments),
                        _compact_json(tool_call.result_details),
                        tool_call.result_text,
                    ),
                )

            for subagent in extracted_session.subagents:
                connection.execute(
                    """
                    INSERT INTO session_subagents (
                      session_id,
                      subagent_id,
                      subagent_type,
                      description,
                      status_text,
                      summary_json,
                      sidechain_status,
                      sidechain_path_hint,
                      sidechain_resolved_path,
                      sidechain_record_count,
                      sidechain_messages_json,
                      raw_evidence_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        extracted_session.session.session_id,
                        subagent.subagent_id,
                        subagent.subagent_type,
                        subagent.description,
                        subagent.status_text,
                        _compact_json(asdict(subagent.summary)),
                        subagent.sidechain.status.value,
                        subagent.sidechain.path_hint,
                        subagent.sidechain.resolved_path,
                        subagent.sidechain.record_count,
                        _compact_json([asdict(message) for message in subagent.sidechain.messages]),
                        _compact_json(subagent.raw_evidence),
                    ),
                )

            for warning_index, warning in enumerate(extracted_session.warnings):
                connection.execute(
                    """
                    INSERT INTO session_warnings (
                      session_id,
                      warning_index,
                      warning_code,
                      severity,
                      scope,
                      line_number,
                      event_id,
                      subagent_id,
                      message,
                      raw_line
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        extracted_session.session.session_id,
                        warning_index,
                        warning.warning_code.value,
                        warning.severity.value,
                        warning.scope.value,
                        warning.line_number,
                        warning.event_id,
                        warning.subagent_id,
                        warning.message,
                        warning.raw_line,
                    ),
                )

            connection.execute(
                "INSERT INTO session_metrics (session_id, metrics_json) VALUES (?, ?)",
                (
                    extracted_session.session.session_id,
                    _compact_json(asdict(extracted_session.metrics)),
                ),
            )



def _compact_json(value: Any) -> str:
    return json.dumps(_normalize_for_json(value), ensure_ascii=False, separators=(",", ":"))



def _normalize_for_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _normalize_for_json(child_value)
            for key, child_value in sorted(value.items())
        }
    if isinstance(value, list):
        return [_normalize_for_json(item) for item in value]
    return value



def _as_sqlite_bool(value: bool | None) -> int | None:
    if value is None:
        return None
    return int(value)


def _migrate_session_tool_calls_primary_key(connection: sqlite3.Connection) -> None:
    primary_key_columns = _primary_key_columns(connection, "session_tool_calls")
    if primary_key_columns == ["session_id", "tool_call_id"]:
        return
    if not primary_key_columns:
        return

    connection.execute("ALTER TABLE session_tool_calls RENAME TO session_tool_calls_old")
    connection.execute(
        """
        CREATE TABLE session_tool_calls (
          session_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          assistant_event_id TEXT,
          tool_result_event_id TEXT,
          is_error INTEGER,
          arguments_json TEXT,
          result_details_json TEXT,
          result_text TEXT,
          PRIMARY KEY (session_id, tool_call_id),
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        )
        """
    )
    connection.execute(
        """
        INSERT INTO session_tool_calls (
          session_id,
          tool_call_id,
          tool_name,
          assistant_event_id,
          tool_result_event_id,
          is_error,
          arguments_json,
          result_details_json,
          result_text
        )
        SELECT
          session_id,
          tool_call_id,
          tool_name,
          assistant_event_id,
          tool_result_event_id,
          is_error,
          arguments_json,
          result_details_json,
          result_text
        FROM session_tool_calls_old
        """
    )
    connection.execute("DROP TABLE session_tool_calls_old")


def _primary_key_columns(connection: sqlite3.Connection, table_name: str) -> list[str]:
    rows = connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    return [
        row[1]
        for row in sorted(
            (row for row in rows if row[5] > 0),
            key=lambda row: row[5],
        )
    ]
