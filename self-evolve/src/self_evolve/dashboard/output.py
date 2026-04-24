from __future__ import annotations

import shutil
import webbrowser
from dataclasses import dataclass
from importlib.resources import as_file, files
from pathlib import Path

DEFAULT_DASHBOARD_NAME = "index.html"
STATIC_DIR_NAME = "static"


@dataclass(frozen=True)
class DashboardOutputPaths:
    output_path: Path
    static_dir: Path


def resolve_dashboard_output_paths(
    input_root: Path,
    output_path: Path | None = None,
) -> DashboardOutputPaths:
    resolved_input_root = input_root.resolve()
    resolved_output_path = (
        output_path.resolve()
        if output_path is not None
        else resolved_input_root / "dashboard" / DEFAULT_DASHBOARD_NAME
    )
    resolved_output_path.parent.mkdir(parents=True, exist_ok=True)
    return DashboardOutputPaths(
        output_path=resolved_output_path,
        static_dir=resolved_output_path.parent / STATIC_DIR_NAME,
    )


def copy_static_assets(static_dir: Path) -> list[Path]:
    static_dir.mkdir(parents=True, exist_ok=True)
    copied_assets: list[Path] = []
    for entry in files("self_evolve.dashboard").joinpath("static").iterdir():
        if not entry.is_file():
            continue
        target_path = static_dir / entry.name
        with as_file(entry) as source_path:
            shutil.copy2(source_path, target_path)
        copied_assets.append(target_path.resolve())
    return copied_assets


def write_dashboard_html(html: str, output_path: Path) -> Path:
    resolved_output_path = output_path.resolve()
    resolved_output_path.parent.mkdir(parents=True, exist_ok=True)
    resolved_output_path.write_text(html, encoding="utf-8")
    return resolved_output_path


def open_dashboard_html(output_path: Path) -> bool:
    return webbrowser.open(output_path.resolve().as_uri())
