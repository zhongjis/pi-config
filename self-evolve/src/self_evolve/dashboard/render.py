from __future__ import annotations

from jinja2 import Environment, PackageLoader, select_autoescape

from self_evolve.dashboard.view_models import DashboardScaffoldViewModel

TEMPLATE_NAME = "dashboard.html.jinja"


def build_template_environment() -> Environment:
    return Environment(
        loader=PackageLoader("self_evolve.dashboard", "templates"),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )


def render_dashboard_html(
    view_model: DashboardScaffoldViewModel,
    *,
    stylesheet_href: str = "static/dashboard.css",
) -> str:
    template = build_template_environment().get_template(TEMPLATE_NAME)
    return template.render(page=view_model, stylesheet_href=stylesheet_href)
