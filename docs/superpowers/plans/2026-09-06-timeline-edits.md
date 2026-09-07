# Timeline Edits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a clip's recipe carry `hold`, `image`, `clip` and speed-changed `source` segments so a user can pause, slow down and splice media at exact points, with captions and hooks re-timed automatically.

**Architecture:** Extend the existing per-clip recipe (`recut.py` segment list) with new segment kinds instead of adding a second edit format. Every helper that walks segments (`normalize_segments`, `total_duration`, `virtual_transcript`, `within_range`, `rebase_segments`, `snap_segments`, `layout_ranges.remap`) becomes kind-aware; `cut_commands` grows a per-kind FFmpeg branch that emits parts encoded like the existing ones so the stream-copy concat is unchanged. `app.py` gains asset upload/list endpoints and passes the assets dir and a media probe into the render; the CLI gains a `recut` command.

**Tech Stack:** Python 3.11, FastAPI, FFmpeg 7 (in the backend container), pytest (run inside the container: `docker compose exec -T backend sh -c 'cd /app && PYTHONPATH=/tmp/pytest-site python -m pytest …'`; if `/tmp/pytest-site` is gone after a container recreate, reinstall with `python -m pip install --target /tmp/pytest-site pytest`).

**Spec:** `docs/superpowers/specs/2026-09-06-timeline-edits-design.md`

## Global Constraints

- Kinds: `source` (default when `kind` absent), `hold`, `image`, `clip`. Unknown kind → `RecutError`.
- `speed` 0.25–4.0 (source only); `hold.ms` 40–3000; `image.ms` 200–10000; `clip` range ≥ `MIN_SEGMENT_SECONDS` (0.5 s).
- `src` is a bare file name resolved only under `output/<job_id>/assets/`; traversal or a disallowed extension → `RecutError`. Image extensions: png jpg jpeg webp gif. Video extensions: mp4 mov.
- `MAX_SEGMENTS` raised from 12 to 24. `MAX_TOTAL_SECONDS` stays 180.
- Plain `{start, end}` recipes stay valid and normalize to exactly `{start, end}` (no `kind`, no `speed`) so every existing test and persisted recipe is untouched. Non-source segments always carry `kind`; a source segment carries `speed` only when it is not 1.0.
- **Fast-path only** for this phase: any hold / image / clip / speed segment requires the canonical (already framed) clip file on the server and every source segment inside the canonical range. Otherwise the endpoint returns 400 with a clear message. (Reason: source-path parts are cut at source resolution and reframed afterwards; inserts are already 9:16, so they cannot join that concat. Documented as a spec constraint in Task 9.)
- All FFmpeg parts use `video_encode_args(QUALITY_FAST)`, `METADATA_SCRUB`, `-movflags +faststart`; audio is AAC. Inserted/hold parts get an `anullsrc` silent track so every part has audio for the concat.
- Commit after every task with the repo's attribution trailer.

---

## File map

| File | Responsibility in this plan |
|---|---|
| `recut.py` | Kind constants, `segment_kind`, `segment_duration`, `source_segments`, `asset_path`, `needs_fast_path`, kind-aware normalize/duration/range/rebase/snap/transcript, per-kind `cut_commands`, probe plumbing in `run_cut_concat`/`perform_recut` |
| `layout_ranges.py` | `remap` advances the offset for non-source segments and scales for speed |
| `app.py` | `RerenderSegment` fields, normalize/fast-path wiring, assets endpoints, EDL `kinds` |
| `cli/openshorts_cli.py` | `recut` command with `--edl` and `--asset` |
| `tests/test_recut.py` | New classes for kinds, durations, transcript, commands |
| `tests/test_layout_ranges.py` | One remap test with a hold |
| `tests/test_rerender_endpoint.py` | Kinds through the endpoint, 400 when not fast, recipe persistence |
| `tests/test_assets_endpoint.py` (new) | PUT/GET assets |
| `tests/test_cli_recut.py` (new) | CLI wiring with a stubbed transport |

Phases (≤5 files each, verify between): **A** = Tasks 1–5 (`recut.py`, `layout_ranges.py`, two test files). **B** = Tasks 6–7 (`app.py`, two test files). **C** = Tasks 8–9 (CLI + docs) and the manual end-to-end run.

---

### Task 1: Kind helpers and kind-aware normalization

**Files:**
- Modify: `recut.py` (constants block lines 25–40, `normalize_segments` lines 45–77, `total_duration` line 79)
- Test: `tests/test_recut.py`

**Interfaces:**
- Produces: `KINDS = ("source", "hold", "image", "clip")`; `segment_kind(seg) -> str`; `segment_duration(seg) -> float`; `source_segments(segments) -> list`; `asset_path(assets_dir, src) -> str` (absolute path, raises `RecutError`); `needs_fast_path(segments) -> bool`; `normalize_segments(segments, source_duration=None, assets_dir=None)`; `total_duration(segments)`.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_recut.py`)

```python
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `docker compose exec -T backend sh -c 'cd /app && PYTHONPATH=/tmp/pytest-site python -m pytest tests/test_recut.py -q -k "TestKinds or TestDurations"'`
Expected: FAIL with `AttributeError: module 'recut' has no attribute 'segment_kind'` (and similar).

- [ ] **Step 3: Implement in `recut.py`**

Replace the constants block and the two functions:

```python
# EDL limits. Deliberately generous — the editor is for humans fixing cuts,
# not for stitching feature films. 24 leaves room for a handful of holds and
# inserts between the source segments.
MAX_SEGMENTS = 24
MIN_SEGMENT_SECONDS = 0.5
MAX_TOTAL_SECONDS = 180.0

# Segment kinds. "source" is the implicit kind of a plain {start, end} entry.
KINDS = ("source", "hold", "image", "clip")
SPEED_MIN, SPEED_MAX = 0.25, 4.0
HOLD_MS_MIN, HOLD_MS_MAX = 40, 3000
IMAGE_MS_MIN, IMAGE_MS_MAX = 200, 10000
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VIDEO_EXTENSIONS = {".mp4", ".mov"}
ASSET_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS
```

```python
def segment_kind(seg):
    return str((seg or {}).get("kind") or "source")


def segment_duration(seg):
    """Seconds this segment occupies on the OUTPUT timeline."""
    kind = segment_kind(seg)
    if kind == "source":
        return round((float(seg["end"]) - float(seg["start"])) / float(seg.get("speed", 1.0)), 3)
    if kind in ("hold", "image"):
        return round(int(seg["ms"]) / 1000.0, 3)
    return round(float(seg["end"]) - float(seg["start"]), 3)  # clip


def source_segments(segments):
    return [s for s in segments if segment_kind(s) == "source"]


def needs_fast_path(segments):
    """True when the recipe uses anything the source (reframe) path cannot
    render: inserts are already 9:16 and speed changes are applied per part,
    so both need the canonical, already-framed clip as the cutting input."""
    return any(segment_kind(s) != "source" or float(s.get("speed", 1.0)) != 1.0
               for s in segments)


def asset_path(assets_dir, src):
    """Absolute path of ``src`` inside ``assets_dir``. Bare file names only:
    a traversal, an unknown extension or a missing file raises RecutError."""
    if not assets_dir:
        raise RecutError("this job has no assets folder; upload the file first")
    name = str(src or "")
    if not name or name != os.path.basename(name) or name.startswith("."):
        raise RecutError(f"src must be a bare file name (got {name!r})")
    ext = os.path.splitext(name)[1].lower()
    if ext not in ASSET_EXTENSIONS:
        raise RecutError(f"src {name!r}: unsupported extension {ext or '(none)'}")
    root = os.path.realpath(assets_dir)
    path = os.path.realpath(os.path.join(root, name))
    if os.path.dirname(path) != root or not os.path.isfile(path):
        raise RecutError(f"src {name!r} is not an uploaded asset of this job")
    return path


def _number(seg, key, i, label):
    try:
        value = float(seg[key])
    except (KeyError, TypeError, ValueError):
        raise RecutError(f"segment {i + 1} ({label}): {key} must be a number")
    if value != value:  # NaN
        raise RecutError(f"segment {i + 1} ({label}): {key} must be a number")
    return value


def _ms(seg, i, label, lo, hi):
    try:
        ms = int(seg["ms"])
    except (KeyError, TypeError, ValueError):
        raise RecutError(f"segment {i + 1} ({label}): ms must be an integer")
    if not lo <= ms <= hi:
        raise RecutError(f"segment {i + 1} ({label}): ms must be {lo}-{hi}")
    return ms


def normalize_segments(segments, source_duration=None, assets_dir=None):
    """Validate and clamp an EDL.

    Returns one dict per segment. Plain source segments come back as exactly
    {'start', 'end'} (plus 'speed' only when it is not 1.0); other kinds carry
    'kind'. Order is preserved — the segment order IS the clip order, and
    reusing a source range twice is legal (an echo/replay is a real editing
    move).
    """
    if not isinstance(segments, (list, tuple)) or not segments:
        raise RecutError("segments must be a non-empty list")
    if len(segments) > MAX_SEGMENTS:
        raise RecutError(f"too many segments (max {MAX_SEGMENTS})")

    normalized = []
    for i, seg in enumerate(segments):
        if not isinstance(seg, dict):
            raise RecutError(f"segment {i + 1} must be an object")
        kind = segment_kind(seg)
        if kind not in KINDS:
            raise RecutError(f"segment {i + 1}: unknown kind {kind!r}")

        if kind == "source":
            start = _number(seg, "start", i, kind)
            end = _number(seg, "end", i, kind)
            start = max(0.0, start)
            if source_duration is not None:
                end = min(float(source_duration), end)
                start = min(start, float(source_duration))
            if end - start < MIN_SEGMENT_SECONDS:
                raise RecutError(
                    f"segment {i + 1} is shorter than {MIN_SEGMENT_SECONDS}s")
            out = {"start": round(start, 3), "end": round(end, 3)}
            if "speed" in seg and seg["speed"] is not None:
                try:
                    speed = float(seg["speed"])
                except (TypeError, ValueError):
                    raise RecutError(f"segment {i + 1}: speed must be a number")
                if not SPEED_MIN <= speed <= SPEED_MAX:
                    raise RecutError(
                        f"segment {i + 1}: speed must be {SPEED_MIN}-{SPEED_MAX}")
                if speed != 1.0:
                    out["speed"] = round(speed, 3)
            normalized.append(out)

        elif kind == "hold":
            at = max(0.0, _number(seg, "at", i, kind))
            if source_duration is not None and at > float(source_duration):
                raise RecutError(f"segment {i + 1} (hold): at is beyond the source")
            normalized.append({"kind": "hold", "at": round(at, 3),
                               "ms": _ms(seg, i, "hold", HOLD_MS_MIN, HOLD_MS_MAX)})

        elif kind == "image":
            path = asset_path(assets_dir, seg.get("src"))
            if os.path.splitext(path)[1].lower() not in IMAGE_EXTENSIONS:
                raise RecutError(f"segment {i + 1} (image): src must be an image file")
            out = {"kind": "image", "src": os.path.basename(path),
                   "ms": _ms(seg, i, "image", IMAGE_MS_MIN, IMAGE_MS_MAX)}
            if seg.get("zoom"):
                out["zoom"] = True
            normalized.append(out)

        else:  # clip
            path = asset_path(assets_dir, seg.get("src"))
            if os.path.splitext(path)[1].lower() not in VIDEO_EXTENSIONS:
                raise RecutError(f"segment {i + 1} (clip): src must be a video file")
            start = max(0.0, _number(seg, "start", i, kind))
            end = _number(seg, "end", i, kind)
            if end - start < MIN_SEGMENT_SECONDS:
                raise RecutError(
                    f"segment {i + 1} is shorter than {MIN_SEGMENT_SECONDS}s")
            normalized.append({"kind": "clip", "src": os.path.basename(path),
                               "start": round(start, 3), "end": round(end, 3)})

    if total_duration(normalized) > MAX_TOTAL_SECONDS:
        raise RecutError(f"clip would exceed {MAX_TOTAL_SECONDS:.0f}s")
    return normalized


def total_duration(segments):
    return round(sum(segment_duration(s) for s in segments), 3)
```

- [ ] **Step 4: Run the whole recut test file**

Run: `docker compose exec -T backend sh -c 'cd /app && PYTHONPATH=/tmp/pytest-site python -m pytest tests/test_recut.py -q'`
Expected: all PASS (old tests untouched because plain segments still normalize to `{start, end}`). One old test asserts `MAX_SEGMENTS` behaviour by count; if it builds 13 segments expecting rejection, change it to build 25.

- [ ] **Step 5: Commit**

```bash
git -C /Users/roti/pontus/openshorts add recut.py tests/test_recut.py
git -C /Users/roti/pontus/openshorts commit -m "recut: segment kinds (hold, image, clip, speed) in normalize/duration" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Range, rebase and snap become kind-aware

**Files:**
- Modify: `recut.py` (`within_range`, `rebase_segments`, `snap_segments`)
- Test: `tests/test_recut.py`

**Interfaces:**
- Consumes: `segment_kind`, `source_segments` from Task 1.
- Produces: same three function names and signatures; non-source segments pass through `rebase_segments`/`snap_segments` untouched except `hold.at` which is rebased like a start.

- [ ] **Step 1: Write the failing tests**

```python
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `… pytest tests/test_recut.py -q -k TestKindAwareRanges`
Expected: FAIL (`KeyError: 'start'` from the current implementations).

- [ ] **Step 3: Implement**

```python
def within_range(segments, range_start, range_end, tolerance=RANGE_TOLERANCE):
    """True when every source segment (and every hold's frame) fits inside
    [range_start, range_end]. Inserts have no source position."""
    lo, hi = float(range_start) - tolerance, float(range_end) + tolerance
    for s in segments:
        kind = segment_kind(s)
        if kind == "source" and not (s["start"] >= lo and s["end"] <= hi):
            return False
        if kind == "hold" and not (lo <= s["at"] <= hi):
            return False
    return True


def rebase_segments(segments, range_start, range_end=None):
    """Map source-absolute segments onto a file cut at ``range_start``.

    Used by the fast path: the canonical clip's t=0 is the source's
    ``range_start``. Clamps to the file bounds so tolerance-admitted segments
    never produce negative seek times. Inserts carry no source time and pass
    through unchanged; a hold's ``at`` is rebased like a start.
    """
    rebased = []
    for seg in segments:
        kind = segment_kind(seg)
        if kind == "source":
            start = max(0.0, seg["start"] - float(range_start))
            end = seg["end"] - float(range_start)
            if range_end is not None:
                end = min(end, float(range_end) - float(range_start))
            out = {"start": round(start, 3), "end": round(end, 3)}
            if seg.get("speed") not in (None, 1.0):
                out["speed"] = seg["speed"]
            rebased.append(out)
        elif kind == "hold":
            at = max(0.0, seg["at"] - float(range_start))
            if range_end is not None:
                at = min(at, float(range_end) - float(range_start))
            rebased.append({"kind": "hold", "at": round(at, 3), "ms": seg["ms"]})
        else:
            rebased.append(dict(seg))
    return rebased


def snap_segments(segments, transcript, source_duration):
    """Snap each source segment's bounds onto word boundaries (ground truth
    beats millisecond arithmetic — same rationale as the pipeline's snapping).
    Non-source segments are returned as they are."""
    from clip_selection import snap_clip_to_words

    words = transcript_words(transcript)
    if not words:
        return segments
    snapped = []
    for seg in segments:
        if segment_kind(seg) != "source":
            snapped.append(dict(seg))
            continue
        start, end = snap_clip_to_words(
            seg["start"], seg["end"], words, source_duration,
            min_duration=MIN_SEGMENT_SECONDS, max_duration=MAX_TOTAL_SECONDS)
        out = {"start": start, "end": end}
        if seg.get("speed") not in (None, 1.0):
            out["speed"] = seg["speed"]
        snapped.append(out)
    return snapped
```

- [ ] **Step 4: Run the file** — Expected: all PASS.
- [ ] **Step 5: Commit** — `recut: kind-aware within_range, rebase and snap`.

---

### Task 3: Transcript re-timing across kinds and speed

**Files:**
- Modify: `recut.py` (`virtual_transcript`)
- Modify: `layout_ranges.py` (`remap`)
- Test: `tests/test_recut.py`, `tests/test_layout_ranges.py`

**Interfaces:**
- Produces: `virtual_transcript(transcript, segments)` unchanged signature; `layout_ranges.remap(ranges, segments)` unchanged signature.

- [ ] **Step 1: Write the failing tests**

`tests/test_recut.py`:
```python
class TestVirtualTranscriptKinds:
    def test_hold_and_image_shift_later_words(self):
        segs = [_seg(10, 15), {"kind": "hold", "at": 15, "ms": 500},
                {"kind": "image", "src": "a.png", "ms": 1000}, _seg(19, 21)]
        vt = recut.virtual_transcript(TRANSCRIPT, segs)
        words = [w for s in vt["segments"] for w in s["words"]]
        # "hello" 12.0 → 2.0 ; "world" 20.0 → (20-19) + 5 + 0.5 + 1.0 = 7.5
        assert [(w["word"].strip(), w["start"]) for w in words] == [("hello", 2.0), ("world", 7.5)]
        assert vt["segments"][-1]["start"] == 6.5 and vt["segments"][-1]["end"] == 8.5

    def test_slow_segment_stretches_words(self):
        segs = [{"start": 10, "end": 14, "speed": 0.5}]
        vt = recut.virtual_transcript(TRANSCRIPT, segs)
        w = vt["segments"][0]["words"][0]
        assert (w["word"].strip(), w["start"], w["end"]) == ("hello", 4.0, 5.0)
        assert vt["segments"][0]["end"] == 8.0
```

`tests/test_layout_ranges.py` (append; use that file's existing import name for the module):
```python
def test_remap_advances_offset_over_holds_and_scales_speed():
    import layout_ranges
    ranges = [{"start": 0.0, "end": 30.0, "layout": "split"}]
    segments = [{"start": 10, "end": 12, "speed": 0.5},
                {"kind": "hold", "at": 12, "ms": 1000},
                {"start": 12, "end": 14}]
    out = layout_ranges.remap(ranges, segments)
    assert out == [{"start": 0.0, "end": 4.0, "layout": "split"},
                   {"start": 5.0, "end": 7.0, "layout": "split"}]
```

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL (`KeyError: 'start'` on the hold).

- [ ] **Step 3: Implement**

`recut.py`:
```python
def virtual_transcript(transcript, segments):
    """Remap a source-absolute transcript onto the concatenated clip timeline.

    Each source segment becomes one synthetic transcript segment whose words
    are shifted so t=0 is the start of the recut clip and scaled by 1/speed
    when the segment is slowed or sped up. Holds and inserts carry no words;
    they only advance the timeline. This is what lets auto-captions and
    subtitle restyles work on edited clips: they keep slicing "words between
    clip_start and clip_end" exactly as before, against this transcript with
    clip_start=0.
    """
    out_segments = []
    offset = 0.0
    for seg in segments:
        duration = segment_duration(seg)
        if segment_kind(seg) != "source":
            offset += duration
            continue
        seg_start, seg_end = float(seg["start"]), float(seg["end"])
        scale = 1.0 / float(seg.get("speed", 1.0))
        words = []
        for w in transcript_words(transcript):
            if w["e"] <= seg_start or w["s"] >= seg_end:
                continue
            words.append({
                # Leading space = Whisper's word-boundary convention.
                # transcript_words() strips it, and without it the caption
                # block collector treats every word as a continuation fragment
                # and burns the whole line glued together.
                "word": " " + w["w"],
                "start": round(max(0.0, w["s"] - seg_start) * scale + offset, 3),
                "end": round(min(seg_end - seg_start, w["e"] - seg_start) * scale + offset, 3),
            })
        out_segments.append({
            "start": round(offset, 3),
            "end": round(offset + duration, 3),
            "text": "".join(w["word"] for w in words).strip(),
            "words": words,
        })
        offset += duration
    return {
        "language": (transcript or {}).get("language", "en"),
        "segments": out_segments,
    }
```

`layout_ranges.py` `remap` body:
```python
    from recut import segment_duration, segment_kind  # lazy: recut imports this module lazily too
    out = []
    offset = 0.0
    for seg in segments or []:
        try:
            duration = segment_duration(seg)
        except (KeyError, TypeError, ValueError):
            continue
        if segment_kind(seg) != "source":
            offset += duration
            continue
        seg_s, seg_e = float(seg["start"]), float(seg["end"])
        if seg_e <= seg_s:
            continue
        scale = 1.0 / float(seg.get("speed", 1.0))
        for r in normalise(ranges):
            s, e = max(r["start"], seg_s), min(r["end"], seg_e)
            if e > s:
                out.append({"start": round((s - seg_s) * scale + offset, 3),
                            "end": round((e - seg_s) * scale + offset, 3),
                            "layout": r["layout"]})
        offset += duration
    return out
```

- [ ] **Step 4: Run both files** — `… pytest tests/test_recut.py tests/test_layout_ranges.py -q` — Expected: all PASS.
- [ ] **Step 5: Commit** — `recut: re-time transcript and layout ranges across holds, inserts and speed`.

---

### Task 4: Per-kind FFmpeg part commands

**Files:**
- Modify: `recut.py` (`cut_commands`, new helpers)
- Test: `tests/test_recut.py`

**Interfaces:**
- Produces: `cut_commands(input_path, segments, part_paths, assets_dir=None, media=None)` where `media` is `{"width": int, "height": int, "fps": float, "has_audio": {abs_path: bool}}`; `probe_media(path) -> {"width","height","fps","has_audio"}` (ffprobe, used only when no `media` is injected).

- [ ] **Step 1: Write the failing tests**

```python
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
```

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL (`TypeError: unexpected keyword 'media'`).

- [ ] **Step 3: Implement**

Add near the top of `recut.py`: `from ffmpeg_utils import (METADATA_SCRUB, QUALITY_FAST, LOUDNORM_FILTER, audio_encode_args, video_encode_args)` (check `LOUDNORM_FILTER` is the module-level name in `ffmpeg_utils.py`; it is used by `audio_encode_args`).

```python
SILENCE_INPUT = ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]


def _atempo_chain(speed):
    """atempo only accepts 0.5–2.0 per stage; chain stages for the rest."""
    parts = []
    remaining = float(speed)
    while remaining < 0.5:
        parts.append("atempo=0.5")
        remaining /= 0.5
    while remaining > 2.0:
        parts.append("atempo=2.0")
        remaining /= 2.0
    parts.append(f"atempo={remaining:g}")
    return ",".join(parts)


def _audio_codec_args():
    """audio_encode_args() minus its -af pair (we fold loudnorm into our own
    -af when a speed filter is present)."""
    args = audio_encode_args()
    if "-af" in args:
        i = args.index("-af")
        args = args[:i] + args[i + 2:]
    return args


def _loudnorm():
    return LOUDNORM_FILTER if os.environ.get("AUDIO_NORMALIZE", "1").strip() != "0" else ""


def _fit_filter(width, height):
    return (f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p")


def _tail(part):
    return [*METADATA_SCRUB, "-movflags", "+faststart", part]


def probe_media(path):
    """{'width','height','fps','has_audio'} via ffprobe; the tests inject
    this dict so the command builders never touch a real file."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=codec_type,width,height,r_frame_rate", "-of", "json", path],
        capture_output=True, text=True, timeout=60).stdout
    info = {"width": 1080, "height": 1920, "fps": 30.0, "has_audio": False}
    for s in json.loads(out or "{}").get("streams", []):
        if s.get("codec_type") == "video" and s.get("width"):
            info["width"], info["height"] = int(s["width"]), int(s["height"])
            num, _, den = str(s.get("r_frame_rate", "30/1")).partition("/")
            try:
                info["fps"] = round(float(num) / float(den or 1), 3) or 30.0
            except ValueError:
                pass
        if s.get("codec_type") == "audio":
            info["has_audio"] = True
    return info


def cut_commands(input_path, segments, part_paths, assets_dir=None, media=None):
    """ffmpeg argv for each part. Every part is re-encoded with uniform
    parameters so the parts concat cleanly, and every part carries an audio
    track (silence for holds and stills) for the same reason.

    ``media`` describes the cutting input (width/height/fps) and which asset
    files have audio; ``perform_recut`` probes it, tests inject it."""
    media = media or {"width": 1080, "height": 1920, "fps": 30.0, "has_audio": {}}
    width, height, fps = int(media["width"]), int(media["height"]), float(media["fps"])
    commands = []
    for seg, part in zip(segments, part_paths):
        kind = segment_kind(seg)
        if kind == "source":
            speed = float(seg.get("speed", 1.0))
            cmd = ["ffmpeg", "-y", "-ss", str(seg["start"]), "-to", str(seg["end"]),
                   "-i", input_path]
            if speed == 1.0:
                cmd += [*video_encode_args(QUALITY_FAST), *audio_encode_args()]
            else:
                af = ",".join(f for f in (_atempo_chain(speed), _loudnorm()) if f)
                cmd += ["-vf", f"setpts=PTS/{speed:g}", *video_encode_args(QUALITY_FAST),
                        "-af", af, *_audio_codec_args()]
            commands.append(cmd + _tail(part))

        elif kind == "hold":
            seconds = seg["ms"] / 1000.0
            fc = (f"[0:v]trim=end_frame=1,setpts=PTS-STARTPTS,"
                  f"tpad=stop_mode=clone:stop_duration={seconds:g}[v]")
            commands.append([
                "ffmpeg", "-y", "-ss", str(seg["at"]), "-i", input_path, *SILENCE_INPUT,
                "-filter_complex", fc, "-map", "[v]", "-map", "1:a",
                "-t", f"{seconds:g}", *video_encode_args(QUALITY_FAST),
                *_audio_codec_args(), *_tail(part)])

        elif kind == "image":
            path = asset_path(assets_dir, seg["src"])
            seconds = seg["ms"] / 1000.0
            frames = max(1, int(round(seconds * fps)))
            if seg.get("zoom"):
                fc = (f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                      f"crop={width}:{height},zoompan=z='1+0.15*on/{frames}':d={frames}:"
                      f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={fps:g},"
                      f"format=yuv420p[v]")
                inputs = ["-i", path]
            else:
                fc = f"[0:v]{_fit_filter(width, height)}[v]"
                inputs = ["-loop", "1", "-framerate", f"{fps:g}", "-t", f"{seconds:g}", "-i", path]
            commands.append([
                "ffmpeg", "-y", *inputs, *SILENCE_INPUT,
                "-filter_complex", fc, "-map", "[v]", "-map", "1:a",
                "-t", f"{seconds:g}", "-r", f"{fps:g}", *video_encode_args(QUALITY_FAST),
                *_audio_codec_args(), *_tail(part)])

        else:  # clip
            path = asset_path(assets_dir, seg["src"])
            has_audio = bool((media.get("has_audio") or {}).get(path))
            cmd = ["ffmpeg", "-y", "-ss", str(seg["start"]), "-to", str(seg["end"]), "-i", path]
            if not has_audio:
                cmd += SILENCE_INPUT
            cmd += ["-filter_complex", f"[0:v]{_fit_filter(width, height)},fps={fps:g}[v]",
                    "-map", "[v]", "-map", "0:a" if has_audio else "1:a",
                    "-t", f"{seg['end'] - seg['start']:g}",
                    *video_encode_args(QUALITY_FAST), *audio_encode_args(), *_tail(part)]
            commands.append(cmd)
    return commands
```

(Add `import json` at the top of `recut.py` if it is not already imported; it is.)

- [ ] **Step 4: Run the file** — Expected: all PASS. The old `cut_commands` tests still pass because the plain-source branch is byte-for-byte the previous command.
- [ ] **Step 5: Commit** — `recut: per-kind ffmpeg parts (speed, hold, image, clip)`.

---

### Task 5: Thread assets dir and media probe through the render

**Files:**
- Modify: `recut.py` (`run_cut_concat`, `perform_recut`)
- Test: `tests/test_recut.py`

**Interfaces:**
- Produces: `run_cut_concat(input_path, segments, out_path, workdir, runner=None, assets_dir=None, media=None)`; `perform_recut(..., assets_dir=None, prober=None)` where `prober(path) -> dict` defaults to `probe_media`. When any segment is non-source or has speed, `perform_recut` probes the input once and every `clip` asset for audio.

- [ ] **Step 1: Write the failing test**

Find the existing `perform_recut` test in `tests/test_recut.py` that injects `runner=` (search for `runner=`); copy its fixture style, then add:

```python
class TestPerformRecutKinds:
    def test_probes_input_and_clip_assets_when_kinds_present(self, tmp_path):
        (tmp_path / "b.mp4").write_bytes(b"x")
        seen, probed = [], []

        def runner(cmd):
            seen.append(cmd)
            # materialise whatever output path the command names last
            open(cmd[-1], "wb").write(b"part")

        def prober(path):
            probed.append(path)
            return {"width": 1080, "height": 1920, "fps": 25.0, "has_audio": False}

        segs = [_seg(0, 2), {"kind": "clip", "src": "b.mp4", "start": 0, "end": 1}]
        served, clean = recut.perform_recut(
            input_path=str(tmp_path / "canon.mp4"), segments=segs,
            output_dir=str(tmp_path), clean_name="c.mp4", reframe=False,
            assets_dir=str(tmp_path), runner=runner, prober=prober)
        assert probed[0].endswith("canon.mp4") and probed[1].endswith("b.mp4")
        clip_cmd = seen[1]
        assert "fps=25" in clip_cmd[clip_cmd.index("-filter_complex") + 1]
        assert "anullsrc" in " ".join(clip_cmd)

    def test_plain_recipe_never_probes(self, tmp_path):
        calls = []
        recut.perform_recut(
            input_path=str(tmp_path / "canon.mp4"), segments=[_seg(0, 2)],
            output_dir=str(tmp_path), clean_name="c.mp4", reframe=False,
            runner=lambda cmd: open(cmd[-1], "wb").write(b"x"),
            prober=lambda p: calls.append(p))
        assert calls == []
```

If the existing `perform_recut` tests need a `layout_ranges` sidecar for the no-reframe branch, mirror what they do (they already pass, so copy their setup).

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL (`TypeError: unexpected keyword 'prober'`).

- [ ] **Step 3: Implement**

In `run_cut_concat`, accept `assets_dir=None, media=None` and pass both to every `cut_commands` call (both the single-segment shortcut and the loop).

In `perform_recut`, add parameters `assets_dir=None, prober=None` and, before `run_cut_concat`:

```python
    media = None
    if needs_fast_path(segments):
        probe = prober or probe_media
        media = probe(input_path)
        media["has_audio"] = {
            asset_path(assets_dir, s["src"]): bool(probe(asset_path(assets_dir, s["src"]))["has_audio"])
            for s in segments if segment_kind(s) == "clip"}
```

and call `run_cut_concat(input_path, segments, work_path, output_dir, runner=runner, assets_dir=assets_dir, media=media)`. Update the docstring: `assets_dir` is the job's assets folder; `prober` is injectable for tests.

- [ ] **Step 4: Run the file** — Expected: all PASS.
- [ ] **Step 5: Commit** — `recut: probe media and thread assets through perform_recut`.

**Phase A gate:** run `tests/test_recut.py tests/test_layout_ranges.py tests/test_rerender_endpoint.py` (the last must still pass untouched). Report, wait for approval.

---

### Task 6: Assets upload and list endpoints

**Files:**
- Modify: `app.py` (near the `/api/uploads` handlers, ~line 2025)
- Create: `tests/test_assets_endpoint.py`

**Interfaces:**
- Produces: `PUT /api/jobs/{job_id}/assets/{name}` (raw body; 201 `{"name","bytes"}`; 400 bad name/extension; 404 unknown job; 413 over `ASSET_MAX_BYTES`); `GET /api/jobs/{job_id}/assets` → `{"assets": [{"name","bytes"}]}`; helper `_assets_dir(job_id) -> str`.

- [ ] **Step 1: Write the failing tests**

```python
"""PUT/GET /api/jobs/{job}/assets — the per-job media folder timeline edits draw from."""
import asyncio
import os

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


@pytest.mark.parametrize("name", ["..%2Fx.png", "x.exe", ".hidden.png", "a%20b.png"])
def test_bad_names_400(job, name):
    assert _request("PUT", f"/api/jobs/{JOB_ID}/assets/{name}", b"x").status_code == 400


def test_unknown_job_404(job):
    assert _request("PUT", "/api/jobs/nope/assets/a.png", b"x").status_code == 404


def test_too_large_413(job, monkeypatch):
    monkeypatch.setattr(app_module, "ASSET_MAX_BYTES", 3)
    assert _request("PUT", f"/api/jobs/{JOB_ID}/assets/a.png", b"1234").status_code == 413
```

- [ ] **Step 2: Run to verify they fail** — `… pytest tests/test_assets_endpoint.py -q` — Expected: 404s from FastAPI (route missing) → assertions fail.

- [ ] **Step 3: Implement** (after the `/api/uploads/{upload_id}` PUT handler in `app.py`)

```python
ASSET_MAX_BYTES = int(os.environ.get("ASSET_MAX_BYTES", str(200 * 1024 * 1024)))
_ASSET_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")


def _assets_dir(job_id: str) -> str:
    return os.path.join(OUTPUT_DIR, job_id, "assets")


def _require_job_dir(job_id: str) -> str:
    job_dir = os.path.join(OUTPUT_DIR, os.path.basename(job_id))
    if job_id not in jobs and not os.path.isdir(job_dir):
        raise HTTPException(status_code=404, detail="Job not found")
    return job_dir


@app.put("/api/jobs/{job_id}/assets/{name}", status_code=201)
async def put_job_asset(job_id: str, name: str, request: Request):
    """Store one media file under the job's assets folder for timeline edits
    (recut segments of kind image/clip reference it by bare file name)."""
    _require_job_dir(job_id)
    if not _ASSET_NAME_RE.match(name) or os.path.splitext(name)[1].lower() not in recut.ASSET_EXTENSIONS:
        raise HTTPException(status_code=400, detail="name must be a plain file name with a png/jpg/jpeg/webp/gif/mp4/mov extension")
    os.makedirs(_assets_dir(job_id), exist_ok=True)
    path = os.path.join(_assets_dir(job_id), name)
    size = 0
    with open(path + ".part", "wb") as f:
        async for chunk in request.stream():
            size += len(chunk)
            if size > ASSET_MAX_BYTES:
                f.close()
                os.remove(path + ".part")
                raise HTTPException(status_code=413, detail=f"asset exceeds {ASSET_MAX_BYTES} bytes")
            f.write(chunk)
    os.replace(path + ".part", path)
    return {"name": name, "bytes": size}


@app.get("/api/jobs/{job_id}/assets")
async def list_job_assets(job_id: str):
    _require_job_dir(job_id)
    folder = _assets_dir(job_id)
    if not os.path.isdir(folder):
        return {"assets": []}
    names = sorted(n for n in os.listdir(folder) if not n.endswith(".part"))
    return {"assets": [{"name": n, "bytes": os.path.getsize(os.path.join(folder, n))} for n in names]}
```

Confirm `import re` exists at the top of `app.py` (grep; add if missing).

- [ ] **Step 4: Run** — Expected: all PASS.
- [ ] **Step 5: Commit** — `api: per-job assets upload/list for timeline edits`.

---

### Task 7: Rerender endpoint accepts kinds; EDL reports them

**Files:**
- Modify: `app.py` (`RerenderSegment` ~line 3252, `_rerender_locked` ~lines 3300–3420, `get_clip_edl` ~line 3180)
- Test: `tests/test_rerender_endpoint.py`

**Interfaces:**
- Consumes: `recut.needs_fast_path`, `recut.source_segments`, `recut.KINDS`, `_assets_dir` (Task 6), `perform_recut(assets_dir=…)` (Task 5).
- Produces: `RerenderSegment` with optional `kind, speed, at, ms, src, zoom`; EDL response gains `"kinds": ["source","hold","image","clip"]` and `limits` gains `speed`, `hold_ms`, `image_ms`.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_rerender_endpoint.py`, reusing its `job` and `fake_recut` fixtures)

```python
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
```

- [ ] **Step 2: Run to verify they fail** — Expected: 422 from pydantic (unknown fields / missing start) → assertions fail.

- [ ] **Step 3: Implement**

`RerenderSegment` (find `class RerenderSegment(BaseModel)` just above `RerenderRequest`):
```python
class RerenderSegment(BaseModel):
    kind: str = "source"
    start: Optional[float] = None
    end: Optional[float] = None
    speed: Optional[float] = None
    at: Optional[float] = None
    ms: Optional[int] = None
    src: Optional[str] = None
    zoom: Optional[bool] = None

    def as_dict(self):
        return {k: v for k, v in self.model_dump().items() if v is not None}
```

In `_rerender_locked`:
1. Replace `[{"start": s.start, "end": s.end} for s in req.segments]` with `[s.as_dict() for s in req.segments]` and pass `assets_dir=_assets_dir(req.job_id)` to **both** `normalize_segments` calls.
2. In the `snap_to_words` clamp block, only clamp source segments:
```python
                segments = [
                    ({"start": round(max(s['start'], canonical_range['start']), 3),
                      "end": round(min(s['end'], canonical_range['end']), 3),
                      **({"speed": s["speed"]} if s.get("speed") else {})}
                     if recut.segment_kind(s) == "source" else s)
                    for s in segments]
```
3. After computing `fast`, before the 409 check:
```python
    if recut.needs_fast_path(segments) and not fast:
        raise HTTPException(
            status_code=400,
            detail=("holds, inserts and speed changes are cut from the original "
                    "clip file, so every source segment must stay inside the "
                    "original clip range and the file must still be on the server"))
```
4. In `run_recut`'s fast branch add `assets_dir=_assets_dir(req.job_id)` to `perform_recut(...)`.
5. Replace the `new_start`/`new_end` lines:
```python
        sources = recut.source_segments(segments) or [canonical_range]
        new_start = min(s['start'] for s in sources)
        new_end = max(s['end'] for s in sources)
```

In `get_clip_edl`'s response dict add:
```python
        "kinds": list(recut.KINDS),
```
and inside its `"limits"` dict add:
```python
            "speed": [recut.SPEED_MIN, recut.SPEED_MAX],
            "hold_ms": [recut.HOLD_MS_MIN, recut.HOLD_MS_MAX],
            "image_ms": [recut.IMAGE_MS_MIN, recut.IMAGE_MS_MAX],
```

- [ ] **Step 4: Run** — `… pytest tests/test_rerender_endpoint.py tests/test_assets_endpoint.py -q` — Expected: all PASS, including the pre-existing rerender tests.
- [ ] **Step 5: Commit** — `api: rerender accepts hold/image/clip/speed segments; EDL advertises kinds`.

**Phase B gate:** run the four touched test files plus `tests/test_mcp_endpoint.py`. Report, wait for approval.

---

### Task 8: CLI `recut` command

**Files:**
- Modify: `cli/openshorts_cli.py` (add `_put_bytes`, `cmd_recut`, parser entry after `publish`)
- Create: `tests/test_cli_recut.py`

**Interfaces:**
- Produces: `openshorts recut <job_id> <clip_index> --edl edits.json [--asset PATH ...] [--no-captions] [--json]`; `_put_bytes(path, data, content_type) -> (status, payload)`.

- [ ] **Step 1: Write the failing test**

```python
"""CLI wiring for `openshorts recut` with the HTTP transport stubbed."""
import importlib.util
import json
import os

import pytest

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
    monkeypatch.setattr(cli, "_put_bytes", lambda path, data, ct: (calls.append(("PUT", path, data)) or (201, {"name": "logo.png"})))
    monkeypatch.setattr(cli, "_request", lambda m, p, body=None: (calls.append((m, p, body)) or (200, {"video_url": "/videos/j/x.mp4"})))
    cli.main(["recut", "job1", "0", "--edl", str(edl), "--asset", str(logo), "--json"])
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
    monkeypatch.setattr(cli, "_request", lambda m, p, body=None: (seen.update(body) or (200, {})))
    cli.main(["recut", "j", "1", "--edl", str(edl), "--no-captions"])
    assert seen["segments"] == [{"start": 0, "end": 5}] and seen["reapply_captions"] is False
```

- [ ] **Step 2: Run to verify it fails** — `… pytest tests/test_cli_recut.py -q` — Expected: FAIL (`argparse` error: invalid choice 'recut'; exit code 2 raised as SystemExit).

- [ ] **Step 3: Implement** (in `cli/openshorts_cli.py`)

Below `_request`:
```python
def _put_bytes(path, data, content_type):
    headers = {"Accept": "application/json", "Content-Type": content_type}
    key = os.environ.get("OPENSHORTS_API_KEY")
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(_base() + path, data=data, headers=headers, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode() or "{}")
        except Exception:
            payload = {"detail": str(e.reason)}
        return e.code, payload
```

Below `cmd_publish`:
```python
_ASSET_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4",
                ".mov": "video/quicktime"}


def cmd_recut(args):
    """Upload any --asset files, then post the edit list as the clip's recipe."""
    for asset in args.asset or []:
        name = os.path.basename(asset)
        ctype = _ASSET_TYPES.get(os.path.splitext(name)[1].lower(), "application/octet-stream")
        with open(asset, "rb") as f:
            status, payload = _put_bytes(f"/api/jobs/{args.job_id}/assets/{name}", f.read(), ctype)
        if status >= 400:
            _die(status, payload)
    with open(args.edl) as f:
        edl = json.load(f)
    segments = edl["segments"] if isinstance(edl, dict) else edl
    body = {"job_id": args.job_id, "clip_index": args.clip_index,
            "segments": segments, "reapply_captions": not args.no_captions}
    status, payload = _request("POST", "/api/clip/rerender", body)
    if status >= 400:
        _die(status, payload)
    print(json.dumps(payload) if args.json else f"rerendered: {payload.get('video_url', payload)}")
```

In `main()` after the `publish` parser:
```python
    p = sub.add_parser("recut", help="re-render one clip from a JSON edit list (holds, slow-downs, image/clip inserts)")
    p.add_argument("job_id")
    p.add_argument("clip_index", type=int)
    p.add_argument("--edl", required=True, help="JSON file: {\"segments\": [...]} or a bare list")
    p.add_argument("--asset", action="append", help="media file to upload first (repeatable)")
    p.add_argument("--no-captions", action="store_true", help="skip re-burning captions")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_recut)
```
Check that `main()` ends by calling `args.func(args)` and that the other parsers add `--json` the same way (copy their exact form).

- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `cli: recut command uploads assets and posts an edit list`.

---

### Task 9: Docs, spec constraint, and the end-to-end run

**Files:**
- Modify: `docs/superpowers/specs/2026-09-06-timeline-edits-design.md` (add the fast-path-only constraint under "Rendering")
- Modify: `cli/README.md` (one usage block for `recut`)
- Modify: `skills/openshorts/SKILL.md` (one sentence under `recut_clip` listing the kinds)
- Vault: `~/pontus/vault/01-Wiki/Developer-Tools/OpenShorts.md` test log entry (research lane commit)

- [ ] **Step 1: Spec constraint** — append to "Rendering": "Phase 1 renders holds, inserts and speed changes only on the fast path (canonical clip on disk, source segments inside the canonical range); otherwise `/api/clip/rerender` returns 400."
- [ ] **Step 2: CLI README + SKILL.md** — add the `recut` usage example from Task 8 and the kinds table from the spec (one line per kind).
- [ ] **Step 3: End-to-end on the Rea clip** (job `6d703f1f-…`, clip 0, canonical range 0–20.957):

```bash
cd ~/pontus/openshorts && cat > /tmp/rea-edits.json <<'EOF'
{"segments": [
  {"start": 0, "end": 15.68},
  {"kind": "hold", "at": 15.68, "ms": 100},
  {"start": 15.68, "end": 19.1, "speed": 0.6},
  {"kind": "image", "src": "rea-logo.png", "ms": 1200, "zoom": true},
  {"start": 19.1, "end": 20.957}
]}
EOF
OPENSHORTS_API_URL=http://127.0.0.1:8000 python3 cli/openshorts_cli.py recut 6d703f1f-bf5d-42f2-9164-586bbb1cbf33 0 --edl /tmp/rea-edits.json --asset <path-to-a-png> --json
```
Expected duration = 15.68 + 0.1 + (3.42/0.6) + 1.2 + 1.857 = 24.537 s (±1 frame). Verify with `ffprobe` on the served file, extract a frame inside the image insert and one inside the slowed range, and eyeball caption alignment in the dashboard (the recipe is persisted, so the editor's subtitle modal re-times against it).

- [ ] **Step 4: Vault log** — dated entry in the OpenShorts note's Test log with the measured duration and any visual findings; commit lane `research`.
- [ ] **Step 5: Commit repo docs** — `docs: timeline edits usage and phase-1 constraint`.

---

## Self-review

- **Spec coverage:** kinds/fields/limits → Task 1; asset resolution + endpoints → Tasks 1, 6; rendering per kind → Task 4; fast/source rule → Tasks 5, 7 (as the phase-1 constraint); timing (`total_duration`, `virtual_transcript`, layout ranges) → Tasks 1, 3; validation → Task 1; surfaces (rerender, EDL `kinds`, assets, CLI) → Tasks 6, 7, 8; MCP schema text → Task 9; tests → every task; end-to-end → Task 9. Overlay mode is out of scope per spec.
- **Placeholders:** none; every code step is concrete. The one conditional instruction (old `MAX_SEGMENTS` test count) names the exact edit.
- **Type consistency:** `media` dict shape is identical in Tasks 4 and 5; `asset_path(assets_dir, src)` is used with the same argument order in Tasks 1, 4, 5; `RerenderSegment.as_dict()` feeds `normalize_segments` which expects raw dicts with optional keys, matching Task 1's parsing.
