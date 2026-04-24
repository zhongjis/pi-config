from importlib.resources import files

from self_evolve import __doc__
from self_evolve.dashboard import build_template_environment, load_session_exports


def test_package_scaffold_imports() -> None:
    assert __doc__ == "Self-evolve Module 1 package scaffold."
    assert callable(load_session_exports)
    assert build_template_environment().loader is not None
    assert files("self_evolve.dashboard").joinpath("templates", "dashboard.html.jinja").is_file()
    assert files("self_evolve.dashboard").joinpath("static", "dashboard.css").is_file()
