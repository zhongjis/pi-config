from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SessionExport:
    export_path: Path
    payload: dict[str, Any]
    session_id: str
    started_at: str | None
    cwd: str | None


def load_session_exports(input_root: Path) -> list[SessionExport]:
    resolved_input_root = input_root.resolve()
    if not resolved_input_root.is_dir():
        raise FileNotFoundError(str(resolved_input_root))

    exports: list[SessionExport] = []
    for export_path in sorted(resolved_input_root.glob("*.json")):
        payload = json.loads(export_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError(f"dashboard input is not a JSON object: {export_path}")

        session_payload = payload.get("session")
        if not isinstance(session_payload, dict):
            raise ValueError(f"dashboard input missing session object: {export_path}")

        session_id = _coerce_string(session_payload.get("session_id"))
        if session_id is None:
            raise ValueError(f"dashboard input missing session.session_id: {export_path}")

        exports.append(
            SessionExport(
                export_path=export_path.resolve(),
                payload=payload,
                session_id=session_id,
                started_at=_coerce_string(session_payload.get("started_at")),
                cwd=_coerce_string(session_payload.get("cwd")),
            )
        )

    return sorted(exports, key=lambda export: (export.started_at or "", export.session_id), reverse=True)


def _coerce_string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None
