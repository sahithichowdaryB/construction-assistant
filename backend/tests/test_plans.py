"""Plan files are scoped to one project (no database, no model)."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from performance import plans  # noqa: E402

PDF = b"%PDF-1.4\n%test\n"


@pytest.fixture()
def dirs(tmp_path, monkeypatch):
    ref, store = tmp_path / "mock", tmp_path / "storage"
    ref.mkdir()
    (ref / "Plan_1_Programme.pdf").write_bytes(PDF)
    monkeypatch.setattr(plans, "PLAN_DIR", ref)
    monkeypatch.setattr(plans, "UPLOAD_DIR", store / "uploaded_plans")
    monkeypatch.setattr(plans, "CACHE_DIR", store / "plan_summaries")
    monkeypatch.setattr(plans, "REFERENCE_PROJECT", "RIV")
    return ref, store


def test_reference_plans_belong_to_the_reference_project_only(dirs):
    assert [p["id"] for p in plans.list_plans("RIV")] == ["plan-1-programme"]
    assert plans.list_plans("TST") == []
    assert plans.find_plan("TST", "plan-1-programme") is None


def test_uploads_are_private_to_their_project(dirs):
    path = plans.save_upload("TST", "Site layout.pdf", PDF)
    assert path.parent.name == "TST"
    assert [p["id"] for p in plans.list_plans("TST")] == ["site-layout"]
    assert "site-layout" not in [p["id"] for p in plans.list_plans("RIV")]
    second = plans.save_upload("TST", "Site layout.pdf", PDF)
    assert second.name == "Site_layout_2.pdf"


def test_legacy_flat_uploads_and_cache_stay_with_the_reference_project(dirs):
    _, store = dirs
    legacy = store / "uploaded_plans"
    legacy.mkdir(parents=True)
    (legacy / "Old.pdf").write_bytes(PDF)
    cache = store / "plan_summaries"
    cache.mkdir(parents=True)
    path = plans.find_plan("RIV", "old")
    (cache / "old.json").write_text(json.dumps({"sha256": plans._digest(path), "key_pages": [], "overview": "x"}))
    assert plans.cached_summary("RIV", "old")["overview"] == "x"
    assert plans.cached_summary("TST", "old") is None


def test_unsafe_project_ids_are_rejected(dirs):
    with pytest.raises(ValueError):
        plans.list_plans("../etc")
