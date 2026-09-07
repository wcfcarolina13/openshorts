"""GIF picker: the GIPHY proxy, and the id-only import that keeps it off the
internal network. (Tenor would have been Discord's source, but Google stopped
issuing keys in Jan 2026 and decommissioned the API that June.)"""
import asyncio
import json

import httpx
import pytest

import giphy

app_module = pytest.importorskip("app")

JOB_ID = "giphy-test-job"
KEY = "test-key"


def _client(handler):
    """An AsyncClient whose requests are answered by ``handler``."""
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True)


def _entry(gif_id="abc123", url="https://media1.giphy.com/media/abc123/giphy.gif"):
    return {"id": gif_id, "title": "a cat",
            "images": {"fixed_width_small": {"url": url, "width": "100", "height": "80"},
                       "downsized": {"url": url, "width": "200", "height": "160"}}}


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def no_ambient_key(monkeypatch):
    monkeypatch.delenv("GIPHY_API_KEY", raising=False)


class TestKeyResolution:
    def test_a_settings_key_beats_the_environment(self, monkeypatch):
        monkeypatch.setenv("GIPHY_API_KEY", "from-env")
        assert giphy.api_key("from-settings") == "from-settings"
        assert giphy.api_key(None) == "from-env"

    def test_blank_is_not_a_key(self, monkeypatch):
        monkeypatch.setenv("GIPHY_API_KEY", "   ")
        assert giphy.api_key("  ") is None

    def test_no_key_anywhere_says_where_to_get_one(self):
        with pytest.raises(giphy.GiphyError) as exc:
            _run(giphy.search("cat"))
        assert exc.value.status == 503
        assert "developers.giphy.com" in exc.value.detail


class TestSearch:
    def test_a_query_hits_search_with_the_strictest_rating(self):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            return httpx.Response(200, json={"data": [_entry()]})

        cards = _run(giphy.search("cat", limit=5, key_override=KEY, client=_client(handler)))
        assert "/v1/gifs/search" in seen["url"]
        assert "q=cat" in seen["url"] and "rating=g" in seen["url"]
        assert f"api_key={KEY}" in seen["url"] and "limit=5" in seen["url"]
        assert cards == [{"id": "abc123", "title": "a cat", "width": 100, "height": 80,
                          "url": "https://media1.giphy.com/media/abc123/giphy.gif"}]

    def test_an_empty_query_shows_trending(self):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            return httpx.Response(200, json={"data": []})

        _run(giphy.search("   ", key_override=KEY, client=_client(handler)))
        assert "/v1/gifs/trending" in seen["url"] and "q=" not in seen["url"]

    def test_unusable_entries_are_dropped_not_rendered_broken(self):
        data = [_entry(), {"id": "no-images"}, {"images": {}}, {"id": "..", "images": {}}]
        handler = lambda r: httpx.Response(200, json={"data": data})
        cards = _run(giphy.search("cat", key_override=KEY, client=_client(handler)))
        assert [c["id"] for c in cards] == ["abc123"]

    def test_limit_is_clamped(self):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            return httpx.Response(200, json={"data": []})

        _run(giphy.search("cat", limit=9999, key_override=KEY, client=_client(handler)))
        assert f"limit={giphy.SEARCH_LIMIT_MAX}" in seen["url"]

    def test_a_rejected_key_is_reported_as_such(self):
        handler = lambda r: httpx.Response(401, json={"meta": {"msg": "Unauthorized"}})
        with pytest.raises(giphy.GiphyError, match="rejected the API key"):
            _run(giphy.search("cat", key_override=KEY, client=_client(handler)))

    def test_rate_limiting_keeps_its_status(self):
        handler = lambda r: httpx.Response(429, text="slow down")
        with pytest.raises(giphy.GiphyError) as exc:
            _run(giphy.search("cat", key_override=KEY, client=_client(handler)))
        assert exc.value.status == 429


class TestFetch:
    """The import path. It takes an id so the URL always comes from GIPHY."""

    def _handler(self, entry, body=b"GIF89a-data", media_status=200):
        def handler(request):
            if request.url.path.startswith("/v1/gifs/"):
                return httpx.Response(200, json={"data": entry})
            return httpx.Response(media_status, content=body)
        return handler

    def test_looks_the_id_up_then_downloads_what_giphy_returned(self):
        data = _run(giphy.fetch("abc123", key_override=KEY,
                                client=_client(self._handler(_entry()))))
        assert data == b"GIF89a-data"

    def test_a_media_url_off_giphy_is_refused(self):
        """The whole reason this endpoint takes an id: a compromised or odd
        response must not turn into a request at anything we are asked to hit."""
        evil = _entry(url="https://169.254.169.254/latest/meta-data/")
        with pytest.raises(giphy.GiphyError, match="Refusing a media URL"):
            _run(giphy.fetch("abc123", key_override=KEY, client=_client(self._handler(evil))))

    def test_a_lookalike_host_is_refused(self):
        evil = _entry(url="https://giphy.com.evil.example/x.gif")
        with pytest.raises(giphy.GiphyError, match="Refusing a media URL"):
            _run(giphy.fetch("abc123", key_override=KEY, client=_client(self._handler(evil))))

    def test_plain_http_is_refused(self):
        evil = _entry(url="http://media1.giphy.com/media/abc123/giphy.gif")
        with pytest.raises(giphy.GiphyError, match="Refusing a media URL"):
            _run(giphy.fetch("abc123", key_override=KEY, client=_client(self._handler(evil))))

    @pytest.mark.parametrize("bad", ["../../etc/passwd", "a b", "x" * 80, ""])
    def test_a_bad_id_never_reaches_giphy(self, bad):
        def handler(request):
            raise AssertionError("should not have made a request")

        with pytest.raises(giphy.GiphyError) as exc:
            _run(giphy.fetch(bad, key_override=KEY, client=_client(handler)))
        assert exc.value.status == 400

    def test_an_unknown_id_is_a_404(self):
        handler = lambda r: httpx.Response(200, json={"data": {}})
        with pytest.raises(giphy.GiphyError) as exc:
            _run(giphy.fetch("abc123", key_override=KEY, client=_client(handler)))
        assert exc.value.status == 404

    def test_an_oversized_gif_is_refused(self, monkeypatch):
        monkeypatch.setattr(giphy, "GIF_MAX_BYTES", 16)
        handler = self._handler(_entry(), body=b"x" * 512)
        with pytest.raises(giphy.GiphyError) as exc:
            _run(giphy.fetch("abc123", key_override=KEY, client=_client(handler)))
        assert exc.value.status == 413

    def test_an_empty_file_is_not_written(self):
        handler = self._handler(_entry(), body=b"")
        with pytest.raises(giphy.GiphyError, match="empty file"):
            _run(giphy.fetch("abc123", key_override=KEY, client=_client(handler)))

    def test_the_asset_name_is_stable_so_repicking_reuses_the_file(self):
        assert giphy.asset_name("abc123") == "giphy-abc123.gif"


def _request(method, path, headers=None):
    async def _do():
        transport = httpx.ASGITransport(app=app_module.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            return await c.request(method, path, headers=headers or {})
    return asyncio.run(_do())


@pytest.fixture()
def job(tmp_path, monkeypatch):
    out_root = tmp_path / "output"
    (out_root / JOB_ID).mkdir(parents=True)
    monkeypatch.setattr(app_module, "OUTPUT_DIR", str(out_root))
    app_module.jobs[JOB_ID] = {"status": "completed", "logs": [], "result": {}, "user_id": None}
    yield out_root / JOB_ID
    app_module.jobs.pop(JOB_ID, None)


class TestEndpoints:
    def test_search_carries_the_attribution_giphys_terms_require(self, monkeypatch):
        async def fake_search(q, limit=24, key_override=None, client=None):
            return [{"id": "abc123", "title": "", "url": "u", "width": 1, "height": 1}]

        monkeypatch.setattr(giphy, "search", fake_search)
        body = _request("GET", "/api/gifs/search?q=cat").json()
        assert body["attribution"] == "POWERED BY GIPHY"
        assert body["gifs"][0]["id"] == "abc123"

    def test_search_without_a_key_is_a_503_the_ui_can_explain(self):
        r = _request("GET", "/api/gifs/search?q=cat")
        assert r.status_code == 503
        assert "GIPHY API key" in r.json()["detail"]

    def test_the_settings_key_travels_in_a_header_not_the_url(self, monkeypatch):
        seen = {}

        async def fake_search(q, limit=24, key_override=None, client=None):
            seen["key"] = key_override
            return []

        monkeypatch.setattr(giphy, "search", fake_search)
        _request("GET", "/api/gifs/search?q=cat", headers={"X-Giphy-Key": "from-settings"})
        assert seen["key"] == "from-settings"

    def test_import_lands_in_the_jobs_assets_folder(self, job, monkeypatch):
        async def fake_fetch(gif_id, key_override=None, client=None):
            return b"GIF89a-bytes"

        monkeypatch.setattr(giphy, "fetch", fake_fetch)
        r = _request("POST", f"/api/jobs/{JOB_ID}/gifs/abc123")
        assert r.status_code == 201
        assert r.json() == {"name": "giphy-abc123.gif", "bytes": 12}
        assert (job / "assets" / "giphy-abc123.gif").read_bytes() == b"GIF89a-bytes"
        # and it is immediately visible to the editor's asset list
        names = [a["name"] for a in _request("GET", f"/api/jobs/{JOB_ID}/assets").json()["assets"]]
        assert names == ["giphy-abc123.gif"]

    def test_import_leaves_no_part_file_when_the_download_fails(self, job, monkeypatch):
        async def fake_fetch(gif_id, key_override=None, client=None):
            raise giphy.GiphyError("nope", status=404)

        monkeypatch.setattr(giphy, "fetch", fake_fetch)
        assert _request("POST", f"/api/jobs/{JOB_ID}/gifs/abc123").status_code == 404
        assert not (job / "assets").exists() or not list((job / "assets").glob("*.part"))

    def test_import_needs_a_real_job(self, monkeypatch):
        async def fake_fetch(gif_id, key_override=None, client=None):
            raise AssertionError("should not have downloaded anything")

        monkeypatch.setattr(giphy, "fetch", fake_fetch)
        assert _request("POST", "/api/jobs/no-such-job/gifs/abc123").status_code == 404
