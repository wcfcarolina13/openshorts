"""HTTP tests for the clip editor's backend: GET .../edl and POST /api/clip/rerender.

Same conventions as test_mcp_endpoint.py: a real ASGI round-trip against the
imported app (BILLING_ENABLED=0 via conftest, so the self-host branch runs and
no cloud auth or database is involved), with the actual render work stubbed at
the recut.perform_recut seam — these tests own the ENDPOINT contract: request
validation, fast/source path choice, 409 on a gone source, and the persistence
of the recipe into metadata.json and the in-memory job.
"""

import asyncio
import json
import os

import httpx
import pytest

app_module = pytest.importorskip("app")
import recut  # noqa: E402

JOB_ID = "recut-endpoint-test-job"

TRANSCRIPT = {
    "language": "en",
    "segments": [
        {
            "start": 0.0, "end": 60.0, "text": "hello world again",
            "words": [
                {"word": "hello", "start": 12.0, "end": 12.5},
                {"word": "world", "start": 20.0, "end": 20.4},
                {"word": "again", "start": 50.0, "end": 50.5},
            ],
        },
    ],
}


def _request(method, path, json_body=None):
    async def _do():
        transport = httpx.ASGITransport(app=app_module.app)
        async with httpx.AsyncClient(transport=transport,
                                     base_url="http://testserver") as client:
            return await client.request(method, path, json=json_body)
    return asyncio.run(_do())


@pytest.fixture()
def job(tmp_path, monkeypatch):
    """A completed job on disk + in memory: canonical clip, metadata with
    transcript, and a retained source video in the job dir (URL-job style)."""
    out_root = tmp_path / "output"
    up_root = tmp_path / "uploads"
    job_dir = out_root / JOB_ID
    job_dir.mkdir(parents=True)
    up_root.mkdir()
    monkeypatch.setattr(app_module, "OUTPUT_DIR", str(out_root))
    monkeypatch.setattr(app_module, "UPLOAD_DIR", str(up_root))

    clip = {
        "start": 10.0,
        "end": 40.0,
        "video_title_for_youtube_short": "test clip",
        "video_url": f"/videos/{JOB_ID}/mytitle_clip_1.mp4",
    }
    meta = {
        "shorts": [clip],
        "transcript": TRANSCRIPT,
        "source_video": "src.mp4",
        "output_format": "auto",
        "cost_analysis": {},
    }
    (job_dir / "mytitle_metadata.json").write_text(json.dumps(meta))
    (job_dir / "mytitle_clip_1.mp4").write_bytes(b"canonical")
    (job_dir / "src.mp4").write_bytes(b"source")

    app_module.jobs[JOB_ID] = {
        "status": "completed",
        "logs": [],
        "result": {"clips": [dict(clip)], "cost_analysis": {}},
        "user_id": None,
        "watermark": False,
    }
    try:
        yield {"dir": job_dir, "meta_path": job_dir / "mytitle_metadata.json"}
    finally:
        app_module.jobs.pop(JOB_ID, None)


@pytest.fixture()
def fake_recut(monkeypatch):
    """Stub the render seam; records kwargs and materializes the output file."""
    calls = []

    def fake(**kwargs):
        calls.append(kwargs)
        name = f"recut_1_{kwargs['clean_name']}"
        with open(os.path.join(kwargs["output_dir"], name), "wb") as f:
            f.write(b"recut")
        return name, name

    monkeypatch.setattr(recut, "perform_recut", fake)
    return calls


class TestGetEdl:
    def test_synthesizes_recipe_for_pristine_clip(self, job):
        resp = _request("GET", f"/api/clip/{JOB_ID}/0/edl")
        assert resp.status_code == 200
        data = resp.json()
        assert data["segments"] == [{"start": 10.0, "end": 40.0}]
        assert data["canonical_range"] == {"start": 10.0, "end": 40.0}
        assert data["duration"] == 30.0
        assert data["current_file"] == "mytitle_clip_1.mp4"
        assert data["has_captions"] is False
        assert data["source"]["available"] is True
        assert data["source"]["url"] == f"/api/source/{JOB_ID}"
        # The editor gets the whole source transcript, not a window around
        # the clip: a cut can only be extended into words it was sent.
        assert [w["w"] for w in data["words"]] == ["hello", "world", "again"]
        assert data["limits"]["max_segments"] == recut.MAX_SEGMENTS
        # Self-host meters nothing.
        assert data["rerender_minutes"] == 0

    def test_ships_words_far_outside_the_clip(self, job):
        """The EDL carries the WHOLE source transcript. The old ±45s window
        would drop these words (clip ends at 40s, they start at 200s), and a
        cut can only be extended into material whose words were sent."""
        meta = json.loads(job["meta_path"].read_text())
        meta["transcript"]["segments"].append({
            "start": 200.0, "end": 260.0, "text": "distant tail",
            "words": [
                {"word": "distant", "start": 200.0, "end": 200.4},
                {"word": "tail", "start": 259.0, "end": 259.5},
            ],
        })
        job["meta_path"].write_text(json.dumps(meta))

        data = _request("GET", f"/api/clip/{JOB_ID}/0/edl").json()
        assert [w["w"] for w in data["words"]] == [
            "hello", "world", "again", "distant", "tail"]
        # Word order is the binary-search invariant the editor's follow-along
        # highlight depends on.
        starts = [w["s"] for w in data["words"]]
        assert starts == sorted(starts)

    def test_reports_missing_source(self, job):
        os.remove(job["dir"] / "src.mp4")
        data = _request("GET", f"/api/clip/{JOB_ID}/0/edl").json()
        assert data["source"]["available"] is False
        assert data["source"]["url"] is None
        assert data["source"]["duration_estimated"] is True

    def test_404s(self, job):
        assert _request("GET", "/api/clip/nope/0/edl").status_code == 404
        assert _request("GET", f"/api/clip/{JOB_ID}/7/edl").status_code == 404


class TestRerenderValidation:
    def test_unknown_job_404(self, job, fake_recut):
        resp = _request("POST", "/api/clip/rerender", {
            "job_id": "nope", "clip_index": 0,
            "segments": [{"start": 10, "end": 20}]})
        assert resp.status_code == 404

    def test_clip_index_out_of_range_404(self, job, fake_recut):
        resp = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 5,
            "segments": [{"start": 10, "end": 20}]})
        assert resp.status_code == 404

    def test_invalid_segments_400(self, job, fake_recut):
        for segments in ([], [{"start": 15, "end": 15.1}]):
            resp = _request("POST", "/api/clip/rerender", {
                "job_id": JOB_ID, "clip_index": 0, "segments": segments})
            assert resp.status_code == 400, segments
        assert fake_recut == []

    def test_gone_source_with_outside_segment_409(self, job, fake_recut):
        os.remove(job["dir"] / "src.mp4")
        resp = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0,
            "segments": [{"start": 45, "end": 55}]})
        assert resp.status_code == 409
        assert fake_recut == []

    def test_invalid_framing_400(self, job, fake_recut):
        resp = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0, "framing": "cinematic",
            "segments": [{"start": 12, "end": 30}]})
        assert resp.status_code == 400
        assert fake_recut == []

    def test_framing_without_source_409(self, job, fake_recut):
        os.remove(job["dir"] / "src.mp4")
        resp = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0, "framing": "full",
            "segments": [{"start": 12, "end": 30}]})  # in-range, but framing needs source
        assert resp.status_code == 409
        assert "framing" in resp.json()["detail"]
        assert fake_recut == []

    def test_snap_clamp_inverted_segment_400_not_500(self, job, fake_recut,
                                                     monkeypatch):
        # No source + snap_to_words: a segment fully outside the canonical
        # range clamps to an inverted (end < start) window. That must be
        # rejected as a 400 by the post-snap re-validation, never reach
        # ffmpeg as `-ss 150 -to 30` and surface as a 500.
        os.remove(job["dir"] / "src.mp4")
        monkeypatch.setattr(recut, "snap_segments",
                            lambda segments, transcript, bound: segments)
        resp = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0, "snap_to_words": True,
            "segments": [{"start": 200, "end": 210}]})
        assert resp.status_code == 400
        assert fake_recut == []


class TestRerenderPaths:
    def test_fast_path_cuts_from_canonical_clip(self, job, fake_recut):
        resp = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0,
            "segments": [{"start": 12, "end": 22}, {"start": 30, "end": 35}]})
        assert resp.status_code == 200
        data = resp.json()
        assert data["render_path"] == "fast"
        assert data["new_video_url"] == f"/videos/{JOB_ID}/recut_1_mytitle_clip_1.mp4"
        assert data["duration"] == 15.0

        call = fake_recut[0]
        assert call["input_path"].endswith("mytitle_clip_1.mp4")
        assert call["reframe"] is False
        # Segments arrive rebased onto the canonical file (t=0 is source 10s).
        assert call["segments"] == [{"start": 2.0, "end": 12.0},
                                    {"start": 20.0, "end": 25.0}]
        # Captions re-applied by default, against the clip-relative transcript.
        assert call["captions_transcript"]["segments"][0]["words"]

    def test_source_path_reframes_from_retained_source(self, job, fake_recut):
        resp = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0,
            "segments": [{"start": 45, "end": 55}]})
        assert resp.status_code == 200
        assert resp.json()["render_path"] == "source"
        call = fake_recut[0]
        assert call["input_path"].endswith("src.mp4")
        assert call["reframe"] is True
        assert call["output_format"] == "auto"
        assert call["watermark"] is False
        # Source-absolute times, not rebased.
        assert call["segments"] == [{"start": 45.0, "end": 55.0}]

    def test_reapply_captions_false_skips_the_transcript(self, job, fake_recut):
        resp = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0, "reapply_captions": False,
            "segments": [{"start": 12, "end": 22}]})
        assert resp.status_code == 200
        assert fake_recut[0]["captions_transcript"] is None

    def test_framing_full_forces_source_path_and_persists(self, job, fake_recut):
        # In-range segments would take the fast path, but a framing override
        # must re-reframe from the source with the forced layout.
        resp = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0, "framing": "full",
            "segments": [{"start": 12, "end": 22}]})
        assert resp.status_code == 200
        data = resp.json()
        assert data["render_path"] == "source"
        assert data["framing"] == "full"
        assert data["recipe"]["framing"] == "full"
        call = fake_recut[0]
        assert call["input_path"].endswith("src.mp4")
        assert call["reframe"] is True
        assert call["force_strategy"] == "WIDE"

        # A follow-up trim WITHOUT a framing field inherits the recipe's
        # framing (the look must not silently revert on a plain trim)...
        resp2 = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0,
            "segments": [{"start": 13, "end": 21}]})
        assert resp2.status_code == 200
        assert resp2.json()["framing"] == "full"
        assert fake_recut[1]["force_strategy"] == "WIDE"

        # ...while an explicit 'auto' resets to the classifier and the fast path.
        resp3 = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0, "framing": "auto",
            "segments": [{"start": 13, "end": 21}]})
        assert resp3.status_code == 200
        assert resp3.json()["render_path"] == "fast"
        assert "framing" not in resp3.json()["recipe"]


class TestRerenderPersistence:
    SEGMENTS = [{"start": 10, "end": 15}, {"start": 48, "end": 52}]

    def _rerender(self):
        resp = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0, "segments": self.SEGMENTS})
        assert resp.status_code == 200
        return resp.json()

    def test_recipe_lands_in_metadata_and_memory(self, job, fake_recut):
        data = self._rerender()
        expected_segments = [{"start": 10.0, "end": 15.0},
                             {"start": 48.0, "end": 52.0}]
        assert data["recipe"]["segments"] == expected_segments
        assert data["recipe"]["canonical_range"] == {"start": 10.0, "end": 40.0}
        # Covering range, so downstream start/end stay a sane positive window.
        assert (data["start"], data["end"]) == (10.0, 52.0)

        meta = json.loads(job["meta_path"].read_text())
        stored = meta["shorts"][0]
        assert stored["recipe"]["segments"] == expected_segments
        assert stored["video_url"] == data["new_video_url"]
        mem = app_module.jobs[JOB_ID]["result"]["clips"][0]
        assert mem["recipe"]["segments"] == expected_segments
        assert mem["video_url"] == data["new_video_url"]

    def test_edl_reflects_the_recut(self, job, fake_recut):
        self._rerender()
        data = _request("GET", f"/api/clip/{JOB_ID}/0/edl").json()
        assert data["segments"] == [{"start": 10.0, "end": 15.0},
                                    {"start": 48.0, "end": 52.0}]
        # The canonical range survives, so the fast path stays available.
        assert data["canonical_range"] == {"start": 10.0, "end": 40.0}

    def test_transcript_endpoint_remaps_piecewise(self, job, fake_recut):
        self._rerender()
        data = _request("GET", f"/api/clip/{JOB_ID}/0/transcript").json()
        assert data["durationSec"] == 9.0
        by_text = {c["text"]: c for c in data["captions"]}
        # "hello" (12.0s in source) → 2.0s into the clip.
        assert by_text["hello"]["startMs"] == 2000
        # "again" (50.0s) sits in the second segment → 5.0 + 2.0 = 7.0s.
        assert by_text["again"]["startMs"] == 7000
        # "world" (20.0s) was cut out.
        assert "world" not in by_text


class TestMcpTool:
    def test_recut_clip_is_registered(self):
        import mcp_server
        names = [t["name"] for t in mcp_server.TOOLS]
        assert "recut_clip" in names
        assert "recut_clip" in mcp_server._TOOL_IMPLS


class TestRerenderKinds:
    def test_edl_advertises_kinds_and_limits(self, job):
        data = _request("GET", f"/api/clip/{JOB_ID}/0/edl").json()
        assert data["kinds"] == ["source", "hold", "image", "clip"]
        assert data["limits"]["hold_ms"] == [40, 3000]
        assert data["limits"]["speed"] == [0.25, 4.0]

    def test_hold_and_image_take_the_fast_path_with_assets(self, job, fake_recut):
        assets = job["dir"] / "assets"
        assets.mkdir()
        (assets / "logo.png").write_bytes(b"x")
        resp = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0,
            "segments": [{"start": 10, "end": 20},
                         {"kind": "hold", "at": 20, "ms": 100},
                         {"kind": "image", "src": "logo.png", "ms": 1000, "zoom": True},
                         {"start": 20, "end": 25, "speed": 0.5}]})
        assert resp.status_code == 200, resp.text
        call = fake_recut[0]
        assert call["input_path"].endswith("mytitle_clip_1.mp4")   # canonical = fast
        assert call["assets_dir"] == str(assets)
        assert call["segments"] == [
            {"start": 0.0, "end": 10.0},
            {"kind": "hold", "at": 10.0, "ms": 100},
            {"kind": "image", "src": "logo.png", "ms": 1000, "zoom": True},
            {"start": 10.0, "end": 15.0, "speed": 0.5}]
        meta = json.loads(job["meta_path"].read_text())
        recipe = meta["shorts"][0]["recipe"]
        assert recipe["segments"][1] == {"kind": "hold", "at": 20.0, "ms": 100}
        # Covering source window ignores inserts.
        assert (meta["shorts"][0]["start"], meta["shorts"][0]["end"]) == (10.0, 25.0)

    def test_kinds_outside_canonical_range_400(self, job, fake_recut):
        resp = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0,
            "segments": [{"start": 5, "end": 20}, {"kind": "hold", "at": 20, "ms": 100}]})
        assert resp.status_code == 400
        assert "original clip" in resp.json()["detail"]

    def test_unknown_asset_400(self, job, fake_recut):
        resp = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0,
            "segments": [{"start": 10, "end": 20},
                         {"kind": "image", "src": "missing.png", "ms": 1000}]})
        assert resp.status_code == 400


class TestRerenderKeepsStyling:
    """A recut is cut from the CLEAN file; the burned hook and the remembered
    caption style must be put back on top, hook first."""

    def test_hook_and_caption_style_reapplied_after_recut(self, job, monkeypatch):
        meta = json.loads(job["meta_path"].read_text())
        meta["shorts"][0]["auto_hook"] = {"text": "Big news", "style": "yellow", "position": "top",
                                          "duration_seconds": 4.0, "size": "L"}
        meta["shorts"][0]["caption_style"] = {"font_name": "Verdana", "highlight_color": "#FF69B4", "uppercase": False}
        job["meta_path"].write_text(json.dumps(meta))

        calls = []

        def fake_recut(**kwargs):
            calls.append(("recut", kwargs.get("captions_transcript")))
            name = f"recut_1_{kwargs['clean_name']}"
            open(os.path.join(kwargs["output_dir"], name), "wb").write(b"recut")
            return name, name

        def fake_hook(src, text, dst, **kw):
            calls.append(("hook", os.path.basename(src), text, kw.get("style"), kw.get("font_scale")))
            open(dst, "wb").write(b"hooked")

        def fake_caption(path, transcript, start, end, split_ranges=None, style_overrides=None):
            calls.append(("caption", os.path.basename(path), style_overrides))
            out = os.path.join(os.path.dirname(path), f"subtitled_9_{os.path.basename(path)}")
            open(out, "wb").write(b"cap")
            return out

        import main as main_module
        monkeypatch.setattr(recut, "perform_recut", fake_recut)
        monkeypatch.setattr(app_module, "add_hook_to_video", fake_hook)
        monkeypatch.setattr(main_module, "auto_caption_clip", fake_caption)

        resp = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0,
            "segments": [{"start": 12, "end": 22}]})
        assert resp.status_code == 200, resp.text
        # perform_recut did NOT burn default captions (we finish the chain here)
        assert calls[0] == ("recut", None)
        assert calls[1][:4] == ("hook", "recut_1_mytitle_clip_1.mp4", "Big news", "yellow") and calls[1][4] == 1.3
        assert calls[2][0] == "caption" and calls[2][1].startswith("hooked_") and calls[2][2]["highlight_color"] == "#FF69B4"
        served = resp.json()["new_video_url"].split("/")[-1]
        assert served.startswith("subtitled_9_hooked_") and served.endswith("recut_1_mytitle_clip_1.mp4")

    def test_plain_clip_keeps_the_old_path(self, job, fake_recut):
        resp = _request("POST", "/api/clip/rerender", {
            "job_id": JOB_ID, "clip_index": 0, "segments": [{"start": 12, "end": 22}]})
        assert resp.status_code == 200
        # No hook, no remembered style: captions still come from perform_recut itself.
        assert fake_recut[0]["captions_transcript"] is not None
