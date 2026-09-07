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
