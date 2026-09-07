"""Self-host project list/reopen: finished on-disk jobs stay reachable after 'new project'."""
import asyncio

import httpx
import pytest

app_module = pytest.importorskip("app")


def _request(method, path):
    async def _do():
        transport = httpx.ASGITransport(app=app_module.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            return await c.request(method, path)
    return asyncio.run(_do())


@pytest.fixture()
def two_jobs(tmp_path, monkeypatch):
    out_root = tmp_path / "output"
    monkeypatch.setattr(app_module, "OUTPUT_DIR", str(out_root))
    for jid, title in (("job-a", "first"), ("job-b", "second")):
        (out_root / jid).mkdir(parents=True)
        app_module.jobs[jid] = {
            "status": "completed", "logs": [], "user_id": None,
            "result": {"clips": [{"video_title_for_youtube_short": title, "video_url": f"/videos/{jid}/c.mp4"}]},
        }
    app_module.jobs["job-running"] = {"status": "processing", "logs": [], "result": None, "user_id": None}
    yield
    for jid in ("job-a", "job-b", "job-running"):
        app_module.jobs.pop(jid, None)


def test_lists_only_completed_jobs_with_clips(two_jobs):
    r = _request("GET", "/api/local/projects")
    assert r.status_code == 200
    ids = {p["job_id"] for p in r.json()["projects"]}
    assert ids == {"job-a", "job-b"}
    a = next(p for p in r.json()["projects"] if p["job_id"] == "job-a")
    assert a["title"] == "first" and a["clips"] == 1 and a["video_url"] == "/videos/job-a/c.mp4"


def test_reopen_returns_the_result(two_jobs):
    r = _request("POST", "/api/local/projects/job-b/reopen")
    assert r.status_code == 200
    assert r.json()["job_id"] == "job-b"
    assert r.json()["result"]["clips"][0]["video_title_for_youtube_short"] == "second"


def test_reopen_unknown_or_running_404(two_jobs):
    assert _request("POST", "/api/local/projects/nope/reopen").status_code == 404
    assert _request("POST", "/api/local/projects/job-running/reopen").status_code == 404


@pytest.fixture()
def clip_job(tmp_path, monkeypatch):
    import json
    out_root = tmp_path / "output"
    jid = "job-render"
    (out_root / jid).mkdir(parents=True)
    monkeypatch.setattr(app_module, "OUTPUT_DIR", str(out_root))
    (out_root / jid / "t_metadata.json").write_text(json.dumps(
        {"shorts": [{"video_title_for_youtube_short": "t", "video_url": f"/videos/{jid}/t_clip_1.mp4"}],
         "transcript": {"segments": []}}))
    (out_root / jid / "t_clip_1.mp4").write_bytes(b"clean")
    app_module.jobs[jid] = {"status": "completed", "logs": [], "user_id": None,
                            "result": {"clips": [{"video_url": f"/videos/{jid}/t_clip_1.mp4"}]}}
    yield out_root / jid
    app_module.jobs.pop(jid, None)


def _put(path, content):
    async def _do():
        transport = httpx.ASGITransport(app=app_module.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            return await c.put(path, content=content)
    return asyncio.run(_do())


def _fake_mp4(n=2048):
    return b"\x00\x00\x00\x18ftypisom" + b"\x00" * (n - 12)


def test_browser_render_becomes_the_current_file(clip_job):
    import json
    r = _put("/api/jobs/job-render/clips/0/render", _fake_mp4())
    assert r.status_code == 200, r.text
    name = r.json()["file"]
    assert name.startswith("browser_") and name.endswith("_t_clip_1.mp4")
    assert (clip_job / name).exists()
    meta = json.loads((clip_job / "t_metadata.json").read_text())
    assert meta["shorts"][0]["video_url"].endswith(name)
    assert app_module.jobs["job-render"]["result"]["clips"][0]["video_url"].endswith(name)
    # The resolver used by restore/download/EDL picks it up, and the restyle
    # base walks back to the clean file.
    assert app_module._canonical_clip_file(str(clip_job), "t", 0) == name
    assert app_module._strip_burned_captions(str(clip_job), name) == "t_clip_1.mp4"


def test_browser_render_rejects_non_mp4(clip_job):
    assert _put("/api/jobs/job-render/clips/0/render", b"x" * 4096).status_code == 400
    assert not list(clip_job.glob("browser_*"))


def test_project_state_roundtrip(clip_job):
    import json
    r = _put("/api/local/projects/job-render/state",
             json.dumps({"clips": [{"index": 0, "active_layers": {"hook": {"text": "hi"}}, "server_file": "x.mp4"}]}).encode())
    assert r.status_code == 200
    r = _put("/api/local/projects/job-render/state",
             json.dumps({"clips": [{"index": 0, "server_file": "y.mp4"}]}).encode())
    assert r.status_code == 200
    reopened = _request("POST", "/api/local/projects/job-render/reopen").json()
    clip = reopened["project_state"]["clips"][0]
    assert clip["server_file"] == "y.mp4" and clip["active_layers"] == {"hook": {"text": "hi"}}
