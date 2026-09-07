"""Unit tests for recut.py — the clip editor's EDL engine.

Pure logic only: validation, range math, the piecewise transcript remap that
keeps captions correct on multi-segment clips, and the ffmpeg command shapes.
The heavy render paths are exercised through injected fakes, never real ffmpeg.
"""

import os

import pytest

import recut


def _seg(start, end):
    return {"start": start, "end": end}


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


class TestNormalizeSegments:
    def test_valid_segments_pass_through_in_order(self):
        segs = recut.normalize_segments([_seg(50, 60), _seg(10, 20)])
        # Order is the CLIP order — reordering source material is legal.
        assert segs == [_seg(50.0, 60.0), _seg(10.0, 20.0)]

    def test_clamps_to_source_duration(self):
        segs = recut.normalize_segments([_seg(-5, 20), _seg(90, 500)],
                                        source_duration=100)
        assert segs == [_seg(0.0, 20.0), _seg(90.0, 100.0)]

    def test_rejects_empty_and_non_list(self):
        for bad in ([], None, "nope", {}):
            with pytest.raises(recut.RecutError):
                recut.normalize_segments(bad)

    def test_rejects_bad_numbers(self):
        for bad in ([{"start": "x", "end": 5}], [{"end": 5}],
                    [{"start": float("nan"), "end": 5}]):
            with pytest.raises(recut.RecutError):
                recut.normalize_segments(bad)

    def test_rejects_too_short_segment(self):
        with pytest.raises(recut.RecutError):
            recut.normalize_segments([_seg(10, 10.2)])
        # A clamp can also make it too short — that must fail, not slip by.
        with pytest.raises(recut.RecutError):
            recut.normalize_segments([_seg(99.9, 150)], source_duration=100)

    def test_rejects_too_many_segments(self):
        segs = [_seg(i * 10, i * 10 + 5) for i in range(recut.MAX_SEGMENTS + 1)]
        with pytest.raises(recut.RecutError):
            recut.normalize_segments(segs)

    def test_rejects_total_over_cap(self):
        with pytest.raises(recut.RecutError):
            recut.normalize_segments([_seg(0, recut.MAX_TOTAL_SECONDS + 10)])


class TestRangeMath:
    def test_total_duration(self):
        assert recut.total_duration([_seg(10, 20), _seg(30, 35)]) == 15.0

    def test_within_range(self):
        assert recut.within_range([_seg(10, 20)], 10, 40)
        assert not recut.within_range([_seg(5, 20)], 10, 40)
        assert not recut.within_range([_seg(10, 41)], 10, 40)

    def test_within_range_tolerates_float_noise(self):
        assert recut.within_range([_seg(9.98, 40.02)], 10, 40)

    def test_rebase_segments_clamps_to_file_bounds(self):
        rebased = recut.rebase_segments([_seg(9.98, 40.02)], 10, 40)
        assert rebased == [_seg(0.0, 30.0)]

    def test_rebase_segments_shifts_by_range_start(self):
        rebased = recut.rebase_segments([_seg(15, 25), _seg(30, 35)], 10)
        assert rebased == [_seg(5.0, 15.0), _seg(20.0, 25.0)]


class TestTranscriptWords:
    def test_flattens_and_sorts(self):
        transcript = {
            "segments": [
                {"words": [{"word": "b", "start": 5.0, "end": 5.5}]},
                {"words": [{"word": "a", "start": 1.0, "end": 1.5}]},
            ],
        }
        words = recut.transcript_words(transcript)
        assert [w["w"] for w in words] == ["a", "b"]

    def test_survives_missing_and_broken_words(self):
        transcript = {
            "segments": [
                {"words": None},
                {},
                {"words": [{"word": "ok", "start": "1", "end": 2},
                           {"word": "bad", "start": None, "end": 2}]},
            ],
        }
        words = recut.transcript_words(transcript)
        assert [w["w"] for w in words] == ["ok"]

    def test_empty_transcript(self):
        assert recut.transcript_words(None) == []
        assert recut.transcript_words({}) == []


class TestVirtualTranscript:
    def test_two_segments_remap_onto_clip_timeline(self):
        v = recut.virtual_transcript(TRANSCRIPT, [_seg(10, 15), _seg(48, 52)])
        assert v["language"] == "en"
        assert len(v["segments"]) == 2
        # "hello" (12.0-12.5 in source) → 2.0-2.5 on the clip. The leading
        # space is Whisper's word-boundary convention: without it the caption
        # block collector merges every word into one glued line (regression
        # caught on a real burn: "...creesycambiatodo").
        first = v["segments"][0]
        assert first["words"] == [{"word": " hello", "start": 2.0, "end": 2.5}]
        assert (first["start"], first["end"]) == (0.0, 5.0)
        # "again" (50.0-50.5) → second segment starts at offset 5.0 → 7.0-7.5.
        second = v["segments"][1]
        assert second["words"] == [{"word": " again", "start": 7.0, "end": 7.5}]
        assert (second["start"], second["end"]) == (5.0, 9.0)
        assert first["text"] == "hello"

    def test_partial_overlap_is_clamped_to_the_segment(self):
        # Word 12.0-12.5, segment 12.3-20 → starts at 0, ends at 0.2.
        v = recut.virtual_transcript(TRANSCRIPT, [_seg(12.3, 20)])
        word = v["segments"][0]["words"][0]
        assert word["word"] == " hello"
        assert word["start"] == 0.0
        assert word["end"] == 0.2

    def test_words_outside_every_segment_are_dropped(self):
        v = recut.virtual_transcript(TRANSCRIPT, [_seg(30, 40)])
        assert v["segments"][0]["words"] == []
        assert v["segments"][0]["text"] == ""


class TestSnapSegments:
    def test_snaps_onto_word_boundaries(self):
        # 11.8 is near "hello"'s start (12.0); 20.6 near "world"'s end (20.4).
        snapped = recut.snap_segments([_seg(11.8, 20.6)], TRANSCRIPT, 60.0)
        start, end = snapped[0]["start"], snapped[0]["end"]
        assert 11.5 <= start <= 12.0
        assert 20.4 <= end <= 20.9

    def test_no_words_returns_input(self):
        segs = [_seg(1, 5)]
        assert recut.snap_segments(segs, {"segments": []}, 60.0) is segs


class TestFfmpegCommands:
    @pytest.fixture(autouse=True)
    def _stable_encode_args(self, monkeypatch):
        monkeypatch.setattr(recut, "video_encode_args", lambda tier: ["-c:v", "test"])
        monkeypatch.setattr(recut, "audio_encode_args", lambda: ["-c:a", "test"])

    def test_cut_commands_shape(self):
        commands = recut.cut_commands("in.mp4", [_seg(10, 20), _seg(30, 35)],
                                      ["p0.mp4", "p1.mp4"])
        assert commands[0] == ["ffmpeg", "-y", "-ss", "10", "-to", "20",
                               "-i", "in.mp4", "-c:v", "test", "-c:a", "test",
                               *recut.METADATA_SCRUB,
                               "-movflags", "+faststart",
                               "p0.mp4"]
        assert commands[1][3] == "30" and commands[1][-1] == "p1.mp4"

    def test_concat_command_stream_copies(self):
        cmd = recut.concat_command("list.txt", "out.mp4")
        assert "-c" in cmd and cmd[cmd.index("-c") + 1] == "copy"

    def test_final_outputs_carry_faststart_and_scrub(self):
        # The delivered-artifact invariants: the moov atom must be fronted
        # (browser preview hangs otherwise) and source metadata scrubbed —
        # on the concat join AND on the single-segment direct cut, since both
        # can be the file the fast path serves.
        concat = recut.concat_command("list.txt", "out.mp4")
        single = recut.cut_commands("in.mp4", [_seg(10, 20)], ["out.mp4"])[0]
        for cmd in (concat, single):
            assert "+faststart" in cmd
            assert "-map_metadata" in cmd

    def test_single_segment_cuts_straight_to_output(self, tmp_path):
        ran = []
        recut.run_cut_concat("in.mp4", [_seg(10, 20)],
                             str(tmp_path / "out.mp4"), str(tmp_path),
                             runner=ran.append)
        assert len(ran) == 1
        assert ran[0][-1] == str(tmp_path / "out.mp4")

    def test_multi_segment_concats_and_cleans_parts(self, tmp_path):
        ran = []

        def fake_run(cmd):
            ran.append(cmd)
            with open(cmd[-1], "wb") as f:
                f.write(b"x")

        out = str(tmp_path / "out.mp4")
        recut.run_cut_concat("in.mp4", [_seg(10, 20), _seg(30, 35)], out,
                             str(tmp_path), runner=fake_run)
        # Two cuts + one concat, and no part/list files left behind.
        assert len(ran) == 3
        assert ran[2][:4] == ["ffmpeg", "-y", "-f", "concat"]
        assert os.listdir(tmp_path) == ["out.mp4"]


class TestPerformRecut:
    @pytest.fixture(autouse=True)
    def _stable_encode_args(self, monkeypatch):
        monkeypatch.setattr(recut, "video_encode_args", lambda tier: [])
        monkeypatch.setattr(recut, "audio_encode_args", lambda: [])

    @staticmethod
    def _touching_runner(cmd):
        with open(cmd[-1], "wb") as f:
            f.write(b"x")

    def test_fast_path_no_reframe_no_captions(self, tmp_path):
        served, clean = recut.perform_recut(
            input_path="clip.mp4", segments=[_seg(0, 10)],
            output_dir=str(tmp_path), clean_name="t_clip_1.mp4",
            runner=self._touching_runner)
        assert served == clean
        assert served.startswith("recut_") and served.endswith("_t_clip_1.mp4")
        assert os.path.exists(tmp_path / served)
        # The temp work file is gone.
        assert all(not f.startswith("temp_") for f in os.listdir(tmp_path))

    def test_captions_burn_last_and_win_the_served_name(self, tmp_path):
        captioned = []

        def fake_captioner(path, transcript, start, end):
            captioned.append((os.path.basename(path), start, end))
            out = os.path.join(os.path.dirname(path),
                               f"subtitled_1_{os.path.basename(path)}")
            with open(out, "wb") as f:
                f.write(b"x")
            return out

        v_transcript = {"segments": [{"words": [{"word": "a", "start": 0, "end": 1}]}]}
        served, clean = recut.perform_recut(
            input_path="clip.mp4", segments=[_seg(0, 10)],
            output_dir=str(tmp_path), clean_name="t_clip_1.mp4",
            captions_transcript=v_transcript,
            runner=self._touching_runner, captioner=fake_captioner)
        assert served == f"subtitled_1_{clean}"
        # Captioned over the CLEAN recut, with the clip-relative window.
        assert captioned == [(clean, 0.0, 10.0)]
        # Both files remain: clean for re-styling, captioned for serving.
        assert os.path.exists(tmp_path / clean)
        assert os.path.exists(tmp_path / served)

    def test_source_path_reframes_and_watermarks(self, tmp_path):
        events = []

        def fake_renderer(work, out, output_format):
            events.append(("reframe", output_format))
            with open(out, "wb") as f:
                f.write(b"x")
            return True

        served, clean = recut.perform_recut(
            input_path="source.mp4", segments=[_seg(5, 15)],
            output_dir=str(tmp_path), clean_name="t_clip_1.mp4",
            reframe=True, output_format="vertical", watermark=True,
            runner=self._touching_runner, renderer=fake_renderer,
            watermarker=lambda path: events.append(("watermark",)))
        assert events == [("reframe", "vertical"), ("watermark",)]
        assert served == clean

    def test_renderer_failure_raises_and_cleans_up(self, tmp_path):
        with pytest.raises(RuntimeError):
            recut.perform_recut(
                input_path="source.mp4", segments=[_seg(5, 15)],
                output_dir=str(tmp_path), clean_name="t_clip_1.mp4",
                reframe=True, runner=self._touching_runner,
                renderer=lambda *a: False)
        assert all(not f.startswith("temp_") for f in os.listdir(tmp_path))


class TestKinds:
    def test_plain_segment_is_source_and_unchanged(self):
        assert recut.segment_kind(_seg(1, 2)) == "source"
        assert recut.normalize_segments([_seg(1, 2)]) == [_seg(1.0, 2.0)]

    def test_unknown_kind_rejected(self):
        with pytest.raises(recut.RecutError, match="kind"):
            recut.normalize_segments([{"kind": "wipe", "ms": 100}])

    def test_speed_kept_only_when_not_one(self):
        segs = recut.normalize_segments([
            {"start": 0, "end": 4, "speed": 1.0},
            {"start": 4, "end": 8, "speed": 0.5},
        ])
        assert segs == [_seg(0.0, 4.0), {"start": 4.0, "end": 8.0, "speed": 0.5}]

    @pytest.mark.parametrize("speed", [0.1, 4.5, "fast"])
    def test_speed_out_of_range_rejected(self, speed):
        with pytest.raises(recut.RecutError, match="speed"):
            recut.normalize_segments([{"start": 0, "end": 4, "speed": speed}])

    def test_hold_normalizes_and_clamps_at(self):
        segs = recut.normalize_segments(
            [_seg(0, 5), {"kind": "hold", "at": 5.0, "ms": 100}], source_duration=30)
        assert segs[1] == {"kind": "hold", "at": 5.0, "ms": 100}

    @pytest.mark.parametrize("ms", [10, 5000])
    def test_hold_ms_out_of_range_rejected(self, ms):
        with pytest.raises(recut.RecutError, match="hold"):
            recut.normalize_segments([{"kind": "hold", "at": 1, "ms": ms}])

    def test_hold_at_beyond_source_rejected(self):
        with pytest.raises(recut.RecutError, match="hold"):
            recut.normalize_segments(
                [{"kind": "hold", "at": 31, "ms": 100}], source_duration=30)

    def test_image_requires_assets_dir_and_image_extension(self, tmp_path):
        (tmp_path / "logo.png").write_bytes(b"x")
        segs = recut.normalize_segments(
            [{"kind": "image", "src": "logo.png", "ms": 1200, "zoom": True}],
            assets_dir=str(tmp_path))
        assert segs == [{"kind": "image", "src": "logo.png", "ms": 1200, "zoom": True}]
        with pytest.raises(recut.RecutError, match="assets"):
            recut.normalize_segments(
                [{"kind": "image", "src": "logo.png", "ms": 1200}])
        (tmp_path / "movie.mp4").write_bytes(b"x")
        with pytest.raises(recut.RecutError, match="image"):
            recut.normalize_segments(
                [{"kind": "image", "src": "movie.mp4", "ms": 1200}],
                assets_dir=str(tmp_path))

    def test_src_traversal_and_missing_file_rejected(self, tmp_path):
        with pytest.raises(recut.RecutError, match="src"):
            recut.normalize_segments(
                [{"kind": "image", "src": "../etc/passwd.png", "ms": 500}],
                assets_dir=str(tmp_path))
        with pytest.raises(recut.RecutError, match="src"):
            recut.normalize_segments(
                [{"kind": "image", "src": "nope.png", "ms": 500}],
                assets_dir=str(tmp_path))

    def test_clip_kind(self, tmp_path):
        (tmp_path / "b.mp4").write_bytes(b"x")
        segs = recut.normalize_segments(
            [{"kind": "clip", "src": "b.mp4", "start": 3, "end": 4.5}],
            assets_dir=str(tmp_path))
        assert segs == [{"kind": "clip", "src": "b.mp4", "start": 3.0, "end": 4.5}]
        with pytest.raises(recut.RecutError, match="shorter"):
            recut.normalize_segments(
                [{"kind": "clip", "src": "b.mp4", "start": 3, "end": 3.2}],
                assets_dir=str(tmp_path))

    def test_max_segments_is_24(self):
        assert recut.MAX_SEGMENTS == 24


class TestDurations:
    def test_segment_duration_per_kind(self):
        assert recut.segment_duration(_seg(0, 4)) == 4.0
        assert recut.segment_duration({"start": 0, "end": 4, "speed": 0.5}) == 8.0
        assert recut.segment_duration({"kind": "hold", "at": 1, "ms": 100}) == 0.1
        assert recut.segment_duration({"kind": "image", "src": "a.png", "ms": 1200}) == 1.2
        assert recut.segment_duration({"kind": "clip", "src": "b.mp4", "start": 3, "end": 4.5}) == 1.5

    def test_total_duration_sums_kinds(self):
        segs = [_seg(0, 4), {"kind": "hold", "at": 4, "ms": 100},
                {"start": 4, "end": 6, "speed": 0.5}]
        assert recut.total_duration(segs) == 8.1

    def test_source_segments_filters(self):
        segs = [_seg(0, 4), {"kind": "hold", "at": 4, "ms": 100}]
        assert recut.source_segments(segs) == [_seg(0, 4)]

    def test_needs_fast_path(self):
        assert recut.needs_fast_path([_seg(0, 4)]) is False
        assert recut.needs_fast_path([{"start": 0, "end": 4, "speed": 2.0}]) is True
        assert recut.needs_fast_path([_seg(0, 4), {"kind": "hold", "at": 4, "ms": 100}]) is True


class TestKindAwareRanges:
    def test_within_range_checks_sources_and_hold_at(self):
        segs = [_seg(10, 20), {"kind": "hold", "at": 20, "ms": 100},
                {"kind": "image", "src": "a.png", "ms": 500}]
        assert recut.within_range(segs, 10, 40) is True
        assert recut.within_range([{"kind": "hold", "at": 45, "ms": 100}], 10, 40) is False

    def test_rebase_moves_sources_and_hold_only(self):
        segs = [{"start": 15, "end": 20, "speed": 0.5},
                {"kind": "hold", "at": 20, "ms": 100},
                {"kind": "clip", "src": "b.mp4", "start": 1, "end": 2}]
        out = recut.rebase_segments(segs, 10, 40)
        assert out == [{"start": 5.0, "end": 10.0, "speed": 0.5},
                       {"kind": "hold", "at": 10.0, "ms": 100},
                       {"kind": "clip", "src": "b.mp4", "start": 1, "end": 2}]

    def test_snap_leaves_non_source_segments_alone(self):
        segs = [_seg(11.8, 20.2), {"kind": "hold", "at": 20.2, "ms": 100}]
        out = recut.snap_segments(segs, TRANSCRIPT, 60)
        assert out[1] == {"kind": "hold", "at": 20.2, "ms": 100}
        assert out[0]["start"] <= 12.0 and out[0]["end"] >= 20.4


class TestVirtualTranscriptKinds:
    def test_hold_and_image_shift_later_words(self):
        segs = [_seg(10, 15), {"kind": "hold", "at": 15, "ms": 500},
                {"kind": "image", "src": "a.png", "ms": 1000}, _seg(19, 21)]
        vt = recut.virtual_transcript(TRANSCRIPT, segs)
        words = [w for s in vt["segments"] for w in s["words"]]
        # "hello" 12.0 -> 2.0 ; "world" 20.0 -> (20-19) + 5 + 0.5 + 1.0 = 7.5
        assert [(w["word"].strip(), w["start"]) for w in words] == [("hello", 2.0), ("world", 7.5)]
        assert vt["segments"][-1]["start"] == 6.5 and vt["segments"][-1]["end"] == 8.5

    def test_slow_segment_stretches_words(self):
        segs = [{"start": 10, "end": 14, "speed": 0.5}]
        vt = recut.virtual_transcript(TRANSCRIPT, segs)
        w = vt["segments"][0]["words"][0]
        assert (w["word"].strip(), w["start"], w["end"]) == ("hello", 4.0, 5.0)
        assert vt["segments"][0]["end"] == 8.0


MEDIA = {"width": 1080, "height": 1920, "fps": 30.0, "has_audio": {}}


class TestKindCommands:
    def test_plain_source_command_unchanged(self):
        cmd = recut.cut_commands("in.mp4", [_seg(1, 3)], ["p0.mp4"], media=MEDIA)[0]
        assert cmd[:8] == ["ffmpeg", "-y", "-ss", "1", "-to", "3", "-i", "in.mp4"]
        assert "-vf" not in cmd and "-filter_complex" not in cmd

    def test_speed_uses_setpts_and_atempo_chain(self):
        cmd = recut.cut_commands("in.mp4", [{"start": 1, "end": 3, "speed": 0.25}],
                                 ["p0.mp4"], media=MEDIA)[0]
        assert cmd[cmd.index("-vf") + 1] == "setpts=PTS/0.25"
        af = cmd[cmd.index("-af") + 1]
        assert af.startswith("atempo=0.5,atempo=0.5")
        assert "-c:a" in cmd

    def test_hold_clones_one_frame_with_silence(self):
        cmd = recut.cut_commands("in.mp4", [{"kind": "hold", "at": 2.5, "ms": 100}],
                                 ["p0.mp4"], media=MEDIA)[0]
        assert cmd[2:6] == ["-ss", "2.5", "-i", "in.mp4"]
        assert "anullsrc=r=48000:cl=stereo" in " ".join(cmd)
        fc = cmd[cmd.index("-filter_complex") + 1]
        assert "trim=end_frame=1" in fc and "tpad=stop_mode=clone:stop_duration=0.1" in fc
        assert cmd[cmd.index("-t") + 1] == "0.1"

    def test_image_is_scaled_padded_and_optionally_zoomed(self, tmp_path):
        (tmp_path / "logo.png").write_bytes(b"x")
        plain = recut.cut_commands(
            "in.mp4", [{"kind": "image", "src": "logo.png", "ms": 1200}],
            ["p0.mp4"], assets_dir=str(tmp_path), media=MEDIA)[0]
        assert str(tmp_path / "logo.png") in plain
        fc = plain[plain.index("-filter_complex") + 1]
        assert "scale=1080:1920:force_original_aspect_ratio=decrease" in fc
        assert "pad=1080:1920" in fc and "zoompan" not in fc
        zoom = recut.cut_commands(
            "in.mp4", [{"kind": "image", "src": "logo.png", "ms": 1200, "zoom": True}],
            ["p0.mp4"], assets_dir=str(tmp_path), media=MEDIA)[0]
        assert "zoompan=" in zoom[zoom.index("-filter_complex") + 1]
        assert "d=36" in zoom[zoom.index("-filter_complex") + 1]  # 1.2 s * 30 fps

    def test_clip_maps_silence_when_asset_has_no_audio(self, tmp_path):
        (tmp_path / "b.mp4").write_bytes(b"x")
        seg = {"kind": "clip", "src": "b.mp4", "start": 1, "end": 2}
        with_audio = dict(MEDIA, has_audio={str(tmp_path / "b.mp4"): True})
        cmd = recut.cut_commands("in.mp4", [seg], ["p0.mp4"],
                                 assets_dir=str(tmp_path), media=with_audio)[0]
        assert "anullsrc" not in " ".join(cmd) and "0:a" in cmd
        silent = dict(MEDIA, has_audio={str(tmp_path / "b.mp4"): False})
        cmd = recut.cut_commands("in.mp4", [seg], ["p0.mp4"],
                                 assets_dir=str(tmp_path), media=silent)[0]
        assert "anullsrc" in " ".join(cmd) and "1:a" in cmd

    def test_insert_without_assets_dir_raises(self):
        with pytest.raises(recut.RecutError):
            recut.cut_commands("in.mp4", [{"kind": "image", "src": "a.png", "ms": 500}],
                               ["p0.mp4"], media=MEDIA)


class TestPerformRecutKinds:
    def test_probes_input_and_clip_assets_when_kinds_present(self, tmp_path):
        (tmp_path / "b.mp4").write_bytes(b"x")
        seen, probed = [], []

        def runner(cmd):
            seen.append(cmd)
            with open(cmd[-1], "wb") as f:
                f.write(b"part")

        def prober(path):
            probed.append(path)
            return {"width": 1080, "height": 1920, "fps": 25.0, "has_audio": False}

        segs = [_seg(0, 2), {"kind": "clip", "src": "b.mp4", "start": 0, "end": 1}]
        recut.perform_recut(
            input_path=str(tmp_path / "canon.mp4"), segments=segs,
            output_dir=str(tmp_path), clean_name="c.mp4", reframe=False,
            assets_dir=str(tmp_path), runner=runner, prober=prober)
        assert probed[0].endswith("canon.mp4") and probed[1].endswith("b.mp4")
        clip_cmd = seen[1]
        assert "fps=25" in clip_cmd[clip_cmd.index("-filter_complex") + 1]
        assert "anullsrc" in " ".join(clip_cmd)

    def test_plain_recipe_never_probes(self, tmp_path):
        calls = []

        def runner(cmd):
            with open(cmd[-1], "wb") as f:
                f.write(b"x")

        recut.perform_recut(
            input_path=str(tmp_path / "canon.mp4"), segments=[_seg(0, 2)],
            output_dir=str(tmp_path), clean_name="c.mp4", reframe=False,
            runner=runner, prober=lambda p: calls.append(p))
        assert calls == []


class TestSampleRateAlignment:
    """Parts are stream-copied together, so every generated part must carry
    the cutting input's sample rate or the concat misreads it."""
    MEDIA96 = {"width": 1080, "height": 1920, "fps": 30.0, "sample_rate": 96000, "has_audio": {}}

    def test_silence_and_ar_follow_probed_rate(self, tmp_path):
        (tmp_path / "logo.png").write_bytes(b"x")
        (tmp_path / "b.mp4").write_bytes(b"x")
        segs = [{"kind": "hold", "at": 1, "ms": 100},
                {"kind": "image", "src": "logo.png", "ms": 500},
                {"kind": "clip", "src": "b.mp4", "start": 0, "end": 1},
                {"start": 0, "end": 2, "speed": 0.5}]
        cmds = recut.cut_commands("in.mp4", segs, ["p0", "p1", "p2", "p3"],
                                  assets_dir=str(tmp_path), media=self.MEDIA96)
        for cmd in cmds:
            assert cmd[cmd.index("-ar") + 1] == "96000"
        for cmd in cmds[:3]:
            assert "anullsrc=r=96000:cl=stereo" in " ".join(cmd)

    def test_plain_source_part_sets_no_rate(self):
        cmd = recut.cut_commands("in.mp4", [_seg(0, 2)], ["p0"], media=self.MEDIA96)[0]
        assert "-ar" not in cmd

    def test_probe_media_defaults_include_sample_rate(self, monkeypatch):
        class R:  # fake subprocess result
            stdout = '{"streams": [{"codec_type": "video", "width": 720, "height": 1280, "r_frame_rate": "25/1"}, {"codec_type": "audio", "sample_rate": "44100"}]}'
        monkeypatch.setattr(recut.subprocess, "run", lambda *a, **k: R())
        info = recut.probe_media("x.mp4")
        assert info == {"width": 720, "height": 1280, "fps": 25.0, "sample_rate": 44100, "has_audio": True}
