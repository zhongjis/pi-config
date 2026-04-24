from __future__ import annotations

import json
from pathlib import Path

import pytest

FIXTURE_ROOT = Path(__file__).parent / "fixtures"


@pytest.fixture
def fixture_root() -> Path:
    return FIXTURE_ROOT


@pytest.fixture
def clean_parent_fixture(fixture_root: Path) -> Path:
    return fixture_root / "parent-clean.sample.jsonl"


@pytest.fixture
def malformed_parent_fixture(fixture_root: Path) -> Path:
    return fixture_root / "parent-malformed-truncated.sample.jsonl"


@pytest.fixture
def sidechain_parent_fixture(fixture_root: Path) -> Path:
    return fixture_root / "parent-with-sidechain.sample.jsonl"


@pytest.fixture
def sidechain_output_fixture(fixture_root: Path) -> Path:
    return fixture_root / "sidechain-present.sample.output"


@pytest.fixture
def temp_output_root(tmp_path: Path) -> Path:
    output_root = tmp_path / "extract-output"
    output_root.mkdir()
    return output_root


@pytest.fixture
def temp_sqlite_path(temp_output_root: Path) -> Path:
    return temp_output_root / "self-evolve-test.sqlite3"


def load_fixture_text(name: str) -> str:
    return (FIXTURE_ROOT / name).read_text(encoding="utf-8")


@pytest.fixture
def clean_parent_records(clean_parent_fixture: Path) -> list[dict[str, object]]:
    return [
        json.loads(line)
        for line in clean_parent_fixture.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
