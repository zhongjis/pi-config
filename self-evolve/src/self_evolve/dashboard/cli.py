from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from self_evolve.dashboard.loader import load_session_exports
from self_evolve.dashboard.output import (
    copy_static_assets,
    open_dashboard_html,
    resolve_dashboard_output_paths,
    write_dashboard_html,
)
from self_evolve.dashboard.render import render_dashboard_html
from self_evolve.dashboard.view_models import build_dashboard_view_model

DEFAULT_INPUT_ROOT = Path(".tmp/self-evolve")


def register_dashboard_parser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    dashboard_parser = subparsers.add_parser(
        "dashboard",
        help="Render the static HTML dashboard from persisted Module 1 exports.",
    )
    dashboard_parser.add_argument(
        "--input-root",
        type=Path,
        default=DEFAULT_INPUT_ROOT,
        help="Directory containing persisted Module 1 JSON exports.",
    )
    dashboard_parser.add_argument(
        "--output-path",
        type=Path,
        default=None,
        help="Optional HTML output path. Defaults to <input-root>/dashboard/index.html.",
    )
    dashboard_parser.add_argument(
        "--baseline-session-id",
        type=str,
        default=None,
        help="Optional explicit baseline session ID for the comparison section.",
    )
    dashboard_parser.add_argument(
        "--open",
        action="store_true",
        help="Open the generated HTML file in a browser after writing it.",
    )
    dashboard_parser.set_defaults(handler=run_dashboard)


def run_dashboard(args: argparse.Namespace) -> int:
    resolved_input_root = Path(args.input_root).resolve()
    try:
        session_exports = load_session_exports(resolved_input_root)
        output_paths = resolve_dashboard_output_paths(resolved_input_root, args.output_path)
        html = render_dashboard_html(
            build_dashboard_view_model(
                session_exports,
                input_root=resolved_input_root,
                baseline_session_id=args.baseline_session_id,
            )
        )
        write_dashboard_html(html, output_paths.output_path)
        copied_assets = copy_static_assets(output_paths.static_dir)
        opened_browser = open_dashboard_html(output_paths.output_path) if args.open else False
    except FileNotFoundError as error:
        print(f"error: dashboard input root not found: {error}", file=sys.stderr)
        return 2
    except Exception as error:
        print(f"error: dashboard failed: {error}", file=sys.stderr)
        return 1

    payload = {
        "command": "dashboard",
        "status": "ok",
        "input_root": str(resolved_input_root),
        "output_path": str(output_paths.output_path.resolve()),
        "static_dir": str(output_paths.static_dir.resolve()),
        "session_exports": len(session_exports),
        "static_assets": len(copied_assets),
        "opened_browser": opened_browser,
    }
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")
    return 0
