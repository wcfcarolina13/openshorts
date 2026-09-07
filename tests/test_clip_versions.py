"""Version history: every rendered file of a clip is listed and any of them
can be made current again, bringing a recut's timeline back with it."""
import asyncio
import json
import os
import time

import httpx
import pytest

app_module = pytest.importorskip("app")

JOB = "versions-job"


def _request(method, path, json_body=None):
    async def _do():
        transport = httpx.ASGITransport(app=app_module.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            return await c.request(method, path, json=json_body)
    return asyncio.run(_do())


@pytest.fixture()
def job(tmp_path, monkeypatch):
    out = tmp_path / "output" / JOB
    out.mkdir(parents=True)
    monkeypatch.setattr(app_module, "OUTPUT_DIR", str(tmp_path / "output"))
    clean = "t_clip_1.mp4"
    files = [clean, f"subtitled_100_{clean}", f"hooked_200_{clean}",
             f"subtitled_300_hooked_200_{clean}", f"recut_400_abc123_{clean}",
             f"subtitled_500_recut_400_abc123_{clean}", f"browser_600_{clean}"]
    for i, name in enumerate(files):
        (out / name).write_bytes(b"v")
        os.utime(out / name, (time.time() - 1000 + i * 10, time.time() - 1000 + i * 10))
    (out / f"recut_400_abc123_{clean}.recipe.json").write_text(json.dumps(
        {"recipe": {"v": 1, "segments": [{"start": 2, "end": 8}, {"kind": "hold", "at": 8, "ms": 100}],
                    "canonical_range": {"start": 0, "end": 20}}, "start": 2, "end": 8, "layout_ranges": []}))
    meta = {"shorts": [{"start": 2, "end": 8, "video_url": f"/videos/{JOB}/subtitled_500_recut_400_abc123_{clean}",
                        "recipe": {"v": 1, "segments": [{"start": 2, "end": 8}], "canonical_range": {"start": 0, "end": 20}}}],
            "transcript": {"segments": []}}
    (out / "t_metadata.json").write_text(json.dumps(meta))
    app_module.jobs[JOB] = {"status": "completed", "logs": [], "user_id": None,
                            "result": {"clips": [dict(meta["shorts"][0])]}}
    yield out
    app_module.jobs.pop(JOB, None)


def test_lists_versions_newest_first_with_kinds(job):
    r = _request("GET", f"/api/clip/{JOB}/0/versions")
    assert r.status_code == 200
    vs = r.json()["versions"]
    assert [v["file"].split("_")[0] for v in vs][:3] == ["browser", "subtitled", "recut"]
    by = {v["file"]: v for v in vs}
    assert by["t_clip_1.mp4"]["kinds"] == ["original"]
    assert by["subtitled_300_hooked_200_t_clip_1.mp4"]["kinds"] == ["captions", "hook"]
    assert by["subtitled_500_recut_400_abc123_t_clip_1.mp4"]["kinds"] == ["captions", "timeline"]
    assert by["subtitled_500_recut_400_abc123_t_clip_1.mp4"]["current"] is True
    assert by["browser_600_t_clip_1.mp4"]["kinds"] == ["browser render"]


def test_revert_to_non_recut_resets_timeline(job):
    r = _request("POST", "/api/clip/revert", {"job_id": JOB, "clip_index": 0, "file": "subtitled_300_hooked_200_t_clip_1.mp4"})
    assert r.status_code == 200, r.text
    meta = json.loads((job / "t_metadata.json").read_text())
    clip = meta["shorts"][0]
    assert clip["video_url"].endswith("subtitled_300_hooked_200_t_clip_1.mp4")
    assert clip["recipe"]["segments"] == [{"start": 0, "end": 20}]
    assert (clip["start"], clip["end"]) == (0, 20)
    assert app_module.jobs[JOB]["result"]["clips"][0]["video_url"].endswith("subtitled_300_hooked_200_t_clip_1.mp4")


def test_revert_to_recut_restores_its_recipe(job):
    _request("POST", "/api/clip/revert", {"job_id": JOB, "clip_index": 0, "file": "t_clip_1.mp4"})
    r = _request("POST", "/api/clip/revert", {"job_id": JOB, "clip_index": 0, "file": "recut_400_abc123_t_clip_1.mp4"})
    assert r.status_code == 200, r.text
    clip = json.loads((job / "t_metadata.json").read_text())["shorts"][0]
    assert clip["recipe"]["segments"][1] == {"kind": "hold", "at": 8, "ms": 100}
    assert (clip["start"], clip["end"]) == (2, 8)


def test_revert_unknown_file_404(job):
    assert _request("POST", "/api/clip/revert", {"job_id": JOB, "clip_index": 0, "file": "../etc/passwd"}).status_code == 404
    assert _request("POST", "/api/clip/revert", {"job_id": JOB, "clip_index": 0, "file": "nope.mp4"}).status_code == 404
