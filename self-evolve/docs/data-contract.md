# Module 1 extractor data contract

This document describes the current implemented contract for Module 1 inside `self-evolve/`. It follows the parser, metrics, persistence layer, CLI behavior, and tests that exist today.

## Scope

Module 1 currently owns:
- normalized extraction of one parent session JSONL
- optional sidechain enrichment for linked subagent summaries when a referenced `.output` file still exists
- deterministic JSON export per extracted `session_id`
- SQLite persistence that mirrors the same extracted session for local querying and reruns
- Phase 1 metrics only

Module 1 does not own:
- dashboard or analyzer schemas
- autoresearch lineage or experiment tracking
- long-term archival of `/tmp/pi-subagents-*` sidechain files
- committed raw Pi session logs
- cross-session product features beyond local cache/query behavior

Observed runtime schema facts are documented in `docs/session-log-schema-notes.md`. When this file discusses parent-session or sidechain layout, that notes file is the evidence source.

## Ownership split

### Durable contract: JSON export

The JSON export is the durable Module 1 contract.

It is written to:
- `<output-root>/<session_id>.json`

It must remain:
- deterministic for identical normalized input
- sufficient to rebuild the SQLite cache for the same `session_id`
- the place where warnings and unknown/raw evidence survive durably

### SQLite role: session-scoped cache and query mirror

SQLite mirrors one extracted session into normalized tables.

It is written to:
- `--sqlite-path` when provided
- otherwise `<output-root>/self-evolve.sqlite3`

SQLite is not the only durable store. It intentionally mirrors the export rather than replacing it.

## Top-level export shape

One extracted session writes one JSON document with this top-level order:

```json
{
  "schema_version": 1,
  "session": {},
  "events": [],
  "tool_calls": [],
  "subagents": [],
  "metrics": {},
  "warnings": []
}
```

Determinism rules implemented today:
- top-level keys stay in the order shown above
- the export ends with a trailing newline
- dictionaries are normalized with sorted keys before serialization
- event order follows parent parse order by `sequence`
- subagents are sorted by `subagent_id`
- warnings are sorted by `(scope, line_number, warning_code, subagent_id)`

## Session metadata contract

`session` contains:

```json
{
  "session_id": "session-parent-sidechain",
  "source_path": "/abs/path/to/session.jsonl",
  "source_kind": "parent_session_jsonl",
  "cwd": "/home/example/project",
  "cwd_locator": "--home-example-project--",
  "parent_session_path": "/home/example/project/sessions/previous.jsonl",
  "started_at": "2026-04-23T11:00:00.000Z",
  "ended_at": "2026-04-23T11:00:07.000Z",
  "schema_version": 1,
  "pi_session_version": 3,
  "is_incomplete": false,
  "incomplete_reasons": [],
  "line_counts": {
    "total": 11,
    "parsed": 11,
    "malformed": 0,
    "unknown": 0
  }
}
```

Current implementation notes:
- `session_id` starts from the source filename stem, then the parent `session.id` overrides it when present
- `cwd` and `parent_session_path` come from the parent `session` header when present
- `cwd_locator` comes from the containing directory name of the source file
- `ended_at` is the max top-level record timestamp seen during parsing
- `source_kind` is always `parent_session_jsonl` today

## Normalized events

Every parsed parent record becomes one normalized event:

```json
{
  "event_id": "msg-assistant-3",
  "record_kind": "message",
  "custom_type": null,
  "parent_event_id": "msg-user-2",
  "timestamp": "2026-04-23T11:00:02.000Z",
  "sequence": 5,
  "role": "assistant",
  "status": "ok",
  "payload": {},
  "raw": {}
}
```

Currently normalized parent record families:
- `session` → `session_header`
- `model_change` → `model_change`
- `thinking_level_change` → `thinking_level_change`
- `message.role == "user"` → `message_user`
- `message.role == "assistant"` → `message_assistant`
- `message.role == "toolResult"` → `message_tool_result`
- `custom/customType == "agent-mode"` → `agent_mode`
- `custom/customType == "subagents:record"` → `subagent_record`
- `custom_message/customType == "subagent-notification"` → `subagent_notification`
- unsupported parent record or message-role shapes → `payload.kind = "unknown"` with raw evidence preserved

Unknown message content blocks are preserved as `{"block_kind": "unknown", "raw": ...}` and emit a warning.

## Tool join contract

Joined tool activity is emitted separately from event order:

```json
{
  "tool_call_id": "call-read-1|fc-1",
  "tool_name": "read",
  "session_id": "session-parent-clean",
  "assistant_event_id": "msg-assistant-1",
  "tool_result_event_id": "msg-tool-1",
  "arguments": {
    "path": "/home/example/project/README.md"
  },
  "is_error": false,
  "result_details": null,
  "result_text": "1#AA:Sample README line"
}
```

Join rules implemented today:
- assistant `toolCall` blocks use `content[].id` and `content[].name`
- tool result messages use `message.toolCallId` and `message.toolName`
- unmatched calls/results are still preserved and warned

## Linked subagent contract

One normalized linked subagent is emitted per discovered `subagent_id`.

```json
{
  "subagent_id": "agent-side-1",
  "subagent_type": "chengfeng",
  "description": "Inspect fixtures",
  "status_text": "completed",
  "summary": {
    "record_event_id": "custom-subagent-1",
    "notification_event_id": "custom-message-1",
    "result_text": "Synthetic sanitized summary.",
    "result_preview": "Synthetic sanitized summary.",
    "started_at": "2026-04-23T11:00:02.200Z",
    "completed_at": "2026-04-23T11:00:05.000Z",
    "tool_uses": 2,
    "turn_count": 2,
    "total_tokens": 123,
    "duration_ms": 2900
  },
  "sidechain": {
    "status": "present",
    "path_hint": "/tmp/pi-subagents-1000/home-example-project/session-parent-sidechain/tasks/agent-side-1.output",
    "resolved_path": "/tmp/pi-subagents-1000/home-example-project/session-parent-sidechain/tasks/agent-side-1.output",
    "record_count": 2,
    "messages": [
      {
        "sequence": 0,
        "type": "user",
        "timestamp": "2026-04-23T11:00:02.250Z",
        "role": "user",
        "raw": {}
      }
    ]
  },
  "raw_evidence": {
    "record": {},
    "notification": {}
  }
}
```

### Sidechain status values

Current parser behavior produces these statuses in practice:
- `present` — sidechain file resolved and parsed without sidechain warnings
- `missing` — a path hint existed but the file did not
- `parse_warning` — the file existed but at least one sidechain line was malformed
- `not_referenced` — no path hint was discovered

`unsupported` exists in the model enum as a reserved value, but the current parser does not emit it.

Sidechain rules:
- `/tmp` sidechains are enrichment only
- parent-session extraction remains durable even when sidechains are missing
- record-level summary data is kept even when sidechain body data is unavailable

## Warning contract

Warnings are first-class persisted records and are also printed to stderr by the CLI when extraction still succeeds.

```json
{
  "warning_code": "malformed_json_line",
  "severity": "warning",
  "scope": "parent_session",
  "line_number": 3,
  "event_id": null,
  "subagent_id": null,
  "message": "Line 3 is not valid JSON and was skipped.",
  "raw_line": "this is not valid json"
}
```

Warning codes currently emitted by parser/persistence flows:
- `malformed_json_line`
- `truncated_final_line`
- `unknown_record_kind`
- `unknown_message_block_kind`
- `missing_sidechain_file`
- `sidechain_parse_warning`
- `duplicate_subagent_summary`
- `unmatched_tool_call`
- `unmatched_tool_result`

## Metrics contract

Only Phase 1 metrics are persisted:

```json
{
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
  "unknown_record_count": 0,
  "warning_count": 0,
  "subagent_count": 1
}
```

Non-goals for metrics:
- no `session_score`
- no analyzer findings
- no dashboard-only presentation fields
- no autoresearch lineage fields

## SQLite schema mirrored today

The persistence layer creates and maintains these tables:

```sql
CREATE TABLE sessions (
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
);

CREATE TABLE session_events (
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
);

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
);

CREATE TABLE session_subagents (
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
);

CREATE TABLE session_warnings (
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
);

CREATE TABLE session_metrics (
  session_id TEXT PRIMARY KEY,
  metrics_json TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
```

Current persistence note:
- `raw_export_json` stores the full deterministic JSON export inside SQLite so cache rebuild/debugging stays local
- persistence migrates legacy `session_tool_calls(tool_call_id PRIMARY KEY)` schemas to `(session_id, tool_call_id)` before writing rows

## Re-extract semantics

Replacement is keyed by `session_id`.

Current transaction behavior:
1. calculate Phase 1 metrics from the normalized extraction
2. serialize the deterministic JSON export
3. write `<output-root>/<session_id>.json`
4. upsert the `sessions` row for `session_id`
5. delete child rows for that `session_id` from `session_events`, `session_tool_calls`, `session_subagents`, `session_warnings`, and `session_metrics`
6. insert fresh child rows derived from the current extraction

Verified semantics in tests:
- extracting identical normalized input twice yields byte-identical JSON export
- rerunning the same `session_id` does not duplicate child rows
- stale child rows for that `session_id` are removed on rerun
- the same `tool_call_id` may exist in different sessions after the schema migration

## Incomplete and future-proof handling

Current incomplete-session behavior:
- malformed JSON lines emit `malformed_json_line` and are skipped
- a truncated final line emits `truncated_final_line`, marks `session.is_incomplete = true`, and appends `truncated_final_line` to `incomplete_reasons`
- unknown parent record kinds are preserved as normalized `unknown` payloads with raw evidence and warnings
- missing sidechains stay non-fatal and preserve their path hints when known

## CLI-facing persistence summary

The CLI reports successful persistence on stdout with:
- `session_id`
- resolved `session_path`
- resolved `export_path`
- resolved `sqlite_path`
- counts for `events`, `tool_calls`, `subagents`, and `warnings`

Exit behavior is documented in `../README.md` because it is operator-facing command surface rather than durable export shape.
