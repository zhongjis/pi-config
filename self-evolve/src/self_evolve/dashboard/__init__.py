"""Dashboard package scaffold for Module 2."""

from self_evolve.dashboard.loader import SessionExport, load_session_exports
from self_evolve.dashboard.output import (
    DashboardOutputPaths,
    copy_static_assets,
    open_dashboard_html,
    resolve_dashboard_output_paths,
    write_dashboard_html,
)
from self_evolve.dashboard.render import TEMPLATE_NAME, build_template_environment, render_dashboard_html
from self_evolve.dashboard.view_models import (
    DashboardScaffoldViewModel,
    build_baseline_comparison_view_model,
    build_dashboard_view_model,
    build_session_detail_view_model,
    build_session_list_view_model,
)

__all__ = [
    "DashboardOutputPaths",
    "DashboardScaffoldViewModel",
    "SessionExport",
    "TEMPLATE_NAME",
    "build_baseline_comparison_view_model",
    "build_dashboard_view_model",
    "build_session_detail_view_model",
    "build_session_list_view_model",
    "build_template_environment",
    "copy_static_assets",
    "load_session_exports",
    "open_dashboard_html",
    "render_dashboard_html",
    "resolve_dashboard_output_paths",
    "write_dashboard_html",
]
