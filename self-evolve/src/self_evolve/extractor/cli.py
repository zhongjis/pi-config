from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Sequence

from self_evolve.dashboard.cli import register_dashboard_parser
from self_evolve.extractor.models import ExtractionWarning
from self_evolve.extractor.parser import parse_parent_session
from self_evolve.extractor.persistence import persist_extracted_session
DEFAULT_OUTPUT_ROOT = Path(".tmp/self-evolve")
DEFAULT_SQLITE_NAME = "self-evolve.sqlite3"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m self_evolve.extractor.cli",
        description="Self-evolve extractor and dashboard CLI.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    extract_parser = subparsers.add_parser(
        "extract",
        help="Parse one session and persist deterministic JSON plus SQLite rows.",
    )
    extract_parser.add_argument(
        "session_path",
        type=Path,
        help="Path to a parent session JSONL file or sanitized fixture.",
    )
    extract_parser.add_argument(
        "--output-root",
        type=Path,
        default=DEFAULT_OUTPUT_ROOT,
        help="Directory for extracted per-session JSON exports.",
    )
    extract_parser.add_argument(
        "--sqlite-path",
        type=Path,
        default=None,
        help="Optional SQLite file path for persisted extractor cache rows.",
    )
    extract_parser.set_defaults(handler=run_extract)
    register_dashboard_parser(subparsers)
    return parser



def prepare_extract_io(
    session_path: Path,
    output_root: Path,
    sqlite_path: Path | None = None,
) -> dict[str, str]:
    resolved_session_path = session_path.resolve()
    if not resolved_session_path.is_file():
        raise FileNotFoundError(str(resolved_session_path))

    resolved_output_root = output_root.resolve()
    resolved_output_root.mkdir(parents=True, exist_ok=True)

    resolved_sqlite_path = (
        sqlite_path.resolve()
        if sqlite_path is not None
        else resolved_output_root / DEFAULT_SQLITE_NAME
    )
    resolved_sqlite_path.parent.mkdir(parents=True, exist_ok=True)

    return {
        "session_path": str(resolved_session_path),
        "output_root": str(resolved_output_root),
        "sqlite_path": str(resolved_sqlite_path),
    }



def run_extract(args: argparse.Namespace) -> int:
    try:
        extract_io = prepare_extract_io(
            session_path=args.session_path,
            output_root=args.output_root,
            sqlite_path=args.sqlite_path,
        )
        extracted = parse_parent_session(extract_io["session_path"])
        persisted = persist_extracted_session(
            extracted,
            output_root=Path(extract_io["output_root"]),
            sqlite_path=Path(extract_io["sqlite_path"]),
        )
    except FileNotFoundError as error:
        print(f"error: session path not found: {error}", file=sys.stderr)
        return 2
    except Exception as error:
        print(f"error: extract failed: {error}", file=sys.stderr)
        return 1

    for warning in extracted.warnings:
        print(_format_warning(warning), file=sys.stderr)

    payload = {
        "command": "extract",
        "status": "ok",
        "session_id": persisted.session_id,
        "session_path": extract_io["session_path"],
        "export_path": str(persisted.export_path),
        "sqlite_path": str(persisted.sqlite_path.resolve()),
        "events": persisted.event_count,
        "tool_calls": persisted.tool_call_count,
        "subagents": persisted.subagent_count,
        "warnings": persisted.warning_count,
    }
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")
    return 0



def _format_warning(warning: ExtractionWarning) -> str:
    location_bits: list[str] = [warning.scope.value]
    if warning.line_number is not None:
        location_bits.append(f"line={warning.line_number}")
    if warning.subagent_id is not None:
        location_bits.append(f"subagent_id={warning.subagent_id}")
    return (
        f"warning: [{warning.warning_code.value}] "
        f"{' '.join(location_bits)} {warning.message}"
    )



def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handler = getattr(args, "handler", None)
    if handler is None:
        parser.print_help()
        return 1
    return handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
