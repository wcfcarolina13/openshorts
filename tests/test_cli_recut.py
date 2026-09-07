"""CLI wiring for `openshorts recut` with the HTTP transport stubbed."""
import importlib.util
import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location(
    "openshorts_cli", os.path.join(HERE, "cli", "openshorts_cli.py"))
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


def test_recut_uploads_assets_then_posts_recipe(tmp_path, monkeypatch, capsys):
    edl = tmp_path / "edits.json"
    edl.write_text(json.dumps({"segments": [{"start": 0, "end": 5},
                                             {"kind": "image", "src": "logo.png", "ms": 800}]}))
    logo = tmp_path / "logo.png"
    logo.write_bytes(b"png")
    calls = []

    def fake_put(path, data, ct):
        calls.append(("PUT", path, data))
        return 201, {"name": "logo.png"}

    def fake_request(method, path, body=None):
        calls.append((method, path, body))
        return 200, {"video_url": "/videos/j/x.mp4"}

    monkeypatch.setattr(cli, "_put_bytes", fake_put)
    monkeypatch.setattr(cli, "_request", fake_request)
    cli.main(["--json", "recut", "job1", "0", "--edl", str(edl), "--asset", str(logo)])
    assert calls[0] == ("PUT", "/api/jobs/job1/assets/logo.png", b"png")
    assert calls[1][0:2] == ("POST", "/api/clip/rerender")
    body = calls[1][2]
    assert body["job_id"] == "job1" and body["clip_index"] == 0
    assert body["segments"][1] == {"kind": "image", "src": "logo.png", "ms": 800}
    assert body["reapply_captions"] is True
    assert json.loads(capsys.readouterr().out)["video_url"] == "/videos/j/x.mp4"


def test_recut_accepts_bare_list_edl(tmp_path, monkeypatch):
    edl = tmp_path / "e.json"
    edl.write_text(json.dumps([{"start": 0, "end": 5}]))
    seen = {}

    def fake_request(method, path, body=None):
        seen.update(body)
        return 200, {}

    monkeypatch.setattr(cli, "_request", fake_request)
    cli.main(["recut", "j", "1", "--edl", str(edl), "--no-captions"])
    assert seen["segments"] == [{"start": 0, "end": 5}] and seen["reapply_captions"] is False
