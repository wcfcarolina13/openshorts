"""PUT/GET /api/jobs/{job}/assets — the per-job media folder timeline edits draw from."""
import asyncio

import httpx
import pytest

app_module = pytest.importorskip("app")

JOB_ID = "assets-test-job"


def _request(method, path, content=None):
    async def _do():
        transport = httpx.ASGITransport(app=app_module.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            return await c.request(method, path, content=content)
    return asyncio.run(_do())


@pytest.fixture()
def job(tmp_path, monkeypatch):
    out_root = tmp_path / "output"
    (out_root / JOB_ID).mkdir(parents=True)
    monkeypatch.setattr(app_module, "OUTPUT_DIR", str(out_root))
    app_module.jobs[JOB_ID] = {"status": "completed", "logs": [], "result": {}, "user_id": None}
    yield out_root / JOB_ID
    app_module.jobs.pop(JOB_ID, None)


def test_put_then_list(job):
    r = _request("PUT", f"/api/jobs/{JOB_ID}/assets/logo.png", b"\x89PNG")
    assert r.status_code == 201 and r.json() == {"name": "logo.png", "bytes": 4}
    assert (job / "assets" / "logo.png").read_bytes() == b"\x89PNG"
    r = _request("GET", f"/api/jobs/{JOB_ID}/assets")
    assert r.json() == {"assets": [{"name": "logo.png", "bytes": 4}]}


@pytest.mark.parametrize("name", ["x.exe", ".hidden.png", "a%20b.png"])
def test_bad_names_400(job, name):
    assert _request("PUT", f"/api/jobs/{JOB_ID}/assets/{name}", b"x").status_code == 400


def test_encoded_traversal_never_reaches_disk(job):
    # The router refuses an encoded slash before the handler runs (404); the
    # point is that nothing lands outside the assets folder either way.
    r = _request("PUT", f"/api/jobs/{JOB_ID}/assets/..%2Fx.png", b"x")
    assert r.status_code in (400, 404)
    assert not (job.parent / "x.png").exists() and not (job / "x.png").exists()


def test_unknown_job_404(job):
    assert _request("PUT", "/api/jobs/nope/assets/a.png", b"x").status_code == 404


def test_too_large_413(job, monkeypatch):
    monkeypatch.setattr(app_module, "ASSET_MAX_BYTES", 3)
    assert _request("PUT", f"/api/jobs/{JOB_ID}/assets/a.png", b"1234").status_code == 413
