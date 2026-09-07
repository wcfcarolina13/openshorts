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


def test_versions_carry_a_poster_url(job):
    r = _request("GET", f"/api/clip/{JOB}/0/versions")
    assert r.status_code == 200
    for v in r.json()["versions"]:
        assert v["poster_url"] == f"/api/clip/{JOB}/0/poster/{v['file']}"


def test_poster_renders_once_and_is_served_from_cache(job, monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        # The arguments are the contract: a single frame, scaled, to the
        # cache path beside the video.
        assert cmd[0] == "ffmpeg"
        assert "-frames:v" in cmd and cmd[cmd.index("-frames:v") + 1] == "1"
        open(cmd[-1], "wb").write(b"\xff\xd8jpeg")
        return None

    monkeypatch.setattr(app_module.subprocess, "run", fake_run)
    name = f"recut_400_abc123_t_clip_1.mp4"
    first = _request("GET", f"/api/clip/{JOB}/0/poster/{name}")
    assert first.status_code == 200
    assert first.headers["content-type"] == "image/jpeg"
    assert (job / f"{name}.poster.jpg").exists()
    second = _request("GET", f"/api/clip/{JOB}/0/poster/{name}")
    assert second.status_code == 200
    assert len(calls) == 1, "the second request must be served from the cached still"


def test_poster_refuses_a_file_that_is_not_a_version(job):
    for name in ("../../app.py", "t_metadata.json", "nope.mp4"):
        r = _request("GET", f"/api/clip/{JOB}/0/poster/{name}")
        assert r.status_code == 404, name


def test_prune_keeps_the_newest_the_current_and_the_canonical(job):
    clean = "t_clip_1.mp4"
    current = f"subtitled_500_recut_400_abc123_{clean}"
    removed = app_module._prune_clip_versions(str(job), "t", 0, current, keep=2)
    remaining = {v["file"] for v in app_module._clip_versions(str(job), "t", 0)}
    # newest two, plus the current one and the canonical cut, survive
    assert clean in remaining
    assert current in remaining
    assert removed, "something older should have gone"
    assert current not in removed and clean not in removed
    assert remaining == {clean, current, f"browser_600_{clean}"}, sorted(remaining)


def test_prune_keeps_a_recipe_its_restyle_still_needs(job):
    clean = "t_clip_1.mp4"
    recut = f"recut_400_abc123_{clean}"
    # the recut's own video is old enough to go, but its restyle is current
    app_module._prune_clip_versions(str(job), "t", 0, f"subtitled_500_{recut}", keep=1)
    assert not os.path.exists(job / recut), "the old recut video should be gone"
    assert (job / f"{recut}.recipe.json").exists(), "its timeline must outlive it"


def test_prune_removes_the_poster_with_the_video(job):
    clean = "t_clip_1.mp4"
    victim = job / f"hooked_200_{clean}"
    (job / f"hooked_200_{clean}.poster.jpg").write_bytes(b"jpeg")
    app_module._prune_clip_versions(str(job), "t", 0, f"subtitled_500_recut_400_abc123_{clean}", keep=1)
    assert not victim.exists()
    assert not (job / f"hooked_200_{clean}.poster.jpg").exists()


def test_prune_is_a_no_op_when_history_is_short(job):
    before = {v["file"] for v in app_module._clip_versions(str(job), "t", 0)}
    assert app_module._prune_clip_versions(str(job), "t", 0, "t_clip_1.mp4", keep=50) == []
    assert {v["file"] for v in app_module._clip_versions(str(job), "t", 0)} == before


def test_versions_endpoint_reports_the_budget(job):
    r = _request("GET", f"/api/clip/{JOB}/0/versions")
    body = r.json()
    assert body["keep"] == app_module.VERSION_HISTORY_KEEP
    assert body["bytes"] == sum(v["bytes"] for v in body["versions"])
