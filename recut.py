"""
Recut engine for the clip editor: a per-clip EDL (list of source segments) is
turned into a rendered clip.

The pure helpers here are standard-library only (plus ffmpeg_utils, which is
also light) so the module imports in the thin CI environment; everything heavy
(reframing, watermark, auto-captions live in main.py) is imported lazily and
only on the paths that need it.

Two render paths:

- FAST: every segment falls inside the range the canonical clip was originally
  cut from, so the recut can be cut straight out of the already-reframed
  canonical file. No ML, no source video needed, seconds instead of minutes.
- SOURCE: at least one segment reaches outside that range (or there is no
  canonical file), so the recut is cut from the source video and re-reframed
  with the same engine the pipeline used.
"""

import json
import os
import shutil
import subprocess
import time
import uuid

from ffmpeg_utils import (LOUDNORM_FILTER, METADATA_SCRUB, QUALITY_FAST,
                          audio_encode_args, video_encode_args)

# EDL limits. Deliberately generous — the editor is for humans fixing cuts,
# not for stitching feature films.
MAX_SEGMENTS = 24
MIN_SEGMENT_SECONDS = 0.5
MAX_TOTAL_SECONDS = 180.0

# Segment kinds. "source" is the implicit kind of a plain {start, end} entry;
# the others are timeline edits (see docs/superpowers/specs/2026-09-06-timeline-edits-design.md).
KINDS = ("source", "hold", "image", "clip")
SPEED_MIN, SPEED_MAX = 0.25, 4.0
# Inline overlays: box width as a fraction of the frame's width. Anything
# under 5 % is a speck; 100 % is the whole frame, which is what "fill" is for.
OVERLAY_W_MIN, OVERLAY_W_MAX = 0.05, 1.0
HOLD_MS_MIN, HOLD_MS_MAX = 40, 3000
IMAGE_MS_MIN, IMAGE_MS_MAX = 200, 10000
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VIDEO_EXTENSIONS = {".mp4", ".mov"}
ASSET_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS

# Segments may start/end a hair outside the canonical range through float
# round-tripping; treat them as inside.
RANGE_TOLERANCE = 0.05


class RecutError(ValueError):
    """Invalid EDL — safe to surface verbatim as a 400 detail."""


def segment_kind(seg):
    return str((seg or {}).get("kind") or "source")


def segment_duration(seg):
    """Seconds this segment occupies on the OUTPUT timeline."""
    kind = segment_kind(seg)
    if kind == "source":
        return round((float(seg["end"]) - float(seg["start"]))
                     / float(seg.get("speed", 1.0)), 3)
    if kind in ("hold", "image"):
        return round(int(seg["ms"]) / 1000.0, 3)
    return round(float(seg["end"]) - float(seg["start"]), 3)  # clip


def source_segments(segments):
    return [s for s in segments if segment_kind(s) == "source"]


def needs_fast_path(segments):
    """True when the recipe uses anything the source (reframe) path cannot
    render: inserts are already 9:16, speed changes are applied per part, and
    an overlay's box is a fraction of the delivered frame, so all three need
    the canonical, already-framed clip as the cutting input."""
    return any(segment_kind(s) != "source" or float(s.get("speed", 1.0)) != 1.0
               or s.get("overlay") for s in segments)


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
    if value != value:  # NaN guard
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


def _overlay(seg, i, assets_dir):
    """Validate a source segment's inline overlay, or None if it has none.

    The box is stored as fractions of the frame so a recipe survives being
    re-rendered at another aspect ratio; x/y are the box's top-left corner and
    may sit at the very edge, where the frame crops it.

    Any uploaded asset may ride inline: a still, an animated GIF/sticker or a
    video. Motion overlays loop for as long as the window lasts and their own
    audio is dropped, so the speaker under them is never talked over.
    """
    raw = seg.get("overlay")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise RecutError(f"segment {i + 1}: overlay must be an object")
    src = raw.get("src")
    if not isinstance(src, str) or not src:
        raise RecutError(f"segment {i + 1}: overlay needs a src")
    # asset_path enforces "bare name, known extension, file exists", which is
    # the whole restriction: stills, GIFs and videos may all sit inline.
    path = asset_path(assets_dir, src)

    def frac(key, low, high, default):
        if raw.get(key) is None:
            return default
        try:
            value = float(raw[key])
        except (TypeError, ValueError):
            raise RecutError(f"segment {i + 1}: overlay {key} must be a number")
        return round(min(high, max(low, value)), 4)

    return {"src": os.path.basename(path),
            "x": frac("x", 0.0, 1.0, 0.0),
            "y": frac("y", 0.0, 1.0, 0.0),
            "w": frac("w", OVERLAY_W_MIN, OVERLAY_W_MAX, 0.25)}


def _overlay_input_args(path):
    """Input flags that make an inline overlay repeat for the whole window.

    Empty for a still — overlay's own eof_action=repeat already holds a
    one-frame input. An endless input does NOT end when the footage does (a
    real render ran to 85 MB before it was killed), so every overlay part
    carries an explicit ``-t`` of the footage's own length.
    """
    ext = os.path.splitext(path)[1].lower()
    if ext == ".gif":
        return ["-ignore_loop", "0"]      # a GIF otherwise obeys its own loop count
    if ext in VIDEO_EXTENSIONS:
        return ["-stream_loop", "-1"]
    return []


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
            if seg.get("speed") is not None:
                try:
                    speed = float(seg["speed"])
                except (TypeError, ValueError):
                    raise RecutError(f"segment {i + 1}: speed must be a number")
                if not SPEED_MIN <= speed <= SPEED_MAX:
                    raise RecutError(
                        f"segment {i + 1}: speed must be {SPEED_MIN}-{SPEED_MAX}")
                if speed != 1.0:
                    out["speed"] = round(speed, 3)
            overlay = _overlay(seg, i, assets_dir)
            if overlay:
                out["overlay"] = overlay
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
            if seg.get("overlay"):
                out["overlay"] = dict(seg["overlay"])
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
        if seg.get("overlay"):
            out["overlay"] = dict(seg["overlay"])
        snapped.append(out)
    return snapped


def transcript_words(transcript):
    """Flatten a Whisper transcript to [{'w','s','e'}, ...] sorted by start."""
    words = []
    for segment in (transcript or {}).get("segments", []):
        for w in segment.get("words", []) or []:
            try:
                words.append({
                    "w": str(w.get("word", "")).strip(),
                    "s": float(w["start"]),
                    "e": float(w["end"]),
                })
            except (KeyError, TypeError, ValueError):
                continue
    words.sort(key=lambda w: w["s"])
    return words


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


DEFAULT_SAMPLE_RATE = 48000


def _silence_input(rate):
    return ["-f", "lavfi", "-i", f"anullsrc=r={int(rate)}:cl=stereo"]


def _atempo_chain(speed):
    """atempo only accepts 0.5-2.0 per stage; chain stages for the rest."""
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
    -af when a speed filter is present, and silence needs no normalising)."""
    args = list(audio_encode_args())
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
    """{'width','height','fps','has_audio'} via ffprobe. perform_recut calls
    this; tests inject the dict so the command builders never touch a file."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=codec_type,width,height,r_frame_rate,sample_rate", "-of", "json", path],
        capture_output=True, text=True, timeout=60).stdout
    info = {"width": 1080, "height": 1920, "fps": 30.0,
            "sample_rate": DEFAULT_SAMPLE_RATE, "has_audio": False}
    for st in json.loads(out or "{}").get("streams", []):
        if st.get("codec_type") == "video" and st.get("width"):
            info["width"], info["height"] = int(st["width"]), int(st["height"])
            num, _, den = str(st.get("r_frame_rate", "30/1")).partition("/")
            try:
                info["fps"] = round(float(num) / float(den or 1), 3) or 30.0
            except ValueError:
                pass
        if st.get("codec_type") == "audio":
            info["has_audio"] = True
            try:
                info["sample_rate"] = int(st.get("sample_rate") or DEFAULT_SAMPLE_RATE)
            except (TypeError, ValueError):
                pass
    return info


def cut_commands(input_path, segments, part_paths, assets_dir=None, media=None):
    """ffmpeg argv for each part. Every part is re-encoded with uniform
    parameters so the parts concat cleanly, and every part carries an audio
    track (silence for holds and stills) for the same reason.

    ``media`` describes the cutting input (width/height/fps) and which asset
    files have audio; ``perform_recut`` probes it, tests inject it."""
    media = media or {"width": 1080, "height": 1920, "fps": 30.0, "has_audio": {}}
    width, height, fps = int(media["width"]), int(media["height"]), float(media["fps"])
    # Parts are stream-copied together, so every generated part must carry
    # the cutting input's sample rate (the pipeline's loudnorm output is 96 kHz).
    rate = int(media.get("sample_rate") or DEFAULT_SAMPLE_RATE)
    silence = _silence_input(rate)
    commands = []
    for seg, part in zip(segments, part_paths):
        kind = segment_kind(seg)
        if kind == "source":
            speed = float(seg.get("speed", 1.0))
            overlay = seg.get("overlay")
            cmd = ["ffmpeg", "-y", "-ss", str(seg["start"]), "-to", str(seg["end"]),
                   "-i", input_path]
            if overlay:
                # Composite the asset over the footage: a still is held for the
                # whole part, a GIF or a video loops until the footage under it
                # runs out. Only [0:a] is mapped, so a motion overlay never
                # talks over the speaker. -2 keeps the scaled height even for
                # yuv420p, and PTS-STARTPTS keeps a looped input's timestamps
                # aligned with the footage's.
                ov_path = asset_path(assets_dir, overlay["src"])
                loop_args = _overlay_input_args(ov_path)
                cmd += [*loop_args, "-i", ov_path]
                base = (f"setpts=PTS/{speed:g},fps={fps:g}" if speed != 1.0
                        else f"fps={fps:g}")
                reset = "setpts=PTS-STARTPTS," if loop_args else ""
                fc = (f"[0:v]{base}[base];"
                      f"[1:v]{reset}scale={max(2, round(overlay['w'] * width))}:-2[ov];"
                      f"[base][ov]overlay={round(overlay['x'] * width)}:"
                      f"{round(overlay['y'] * height)}[v]")
                # -t is what bounds the part: a looped overlay input never
                # ends on its own, so without it ffmpeg encodes forever.
                cmd += ["-filter_complex", fc, "-map", "[v]", "-map", "0:a",
                        "-t", f"{segment_duration(seg):g}",
                        *video_encode_args(QUALITY_FAST)]
                if speed != 1.0:
                    af = ",".join(f for f in (_atempo_chain(speed), _loudnorm()) if f)
                    cmd += ["-af", af, "-ar", str(rate), *_audio_codec_args()]
                else:
                    cmd += audio_encode_args()
            elif speed == 1.0:
                # Unchanged from the pre-kinds builder: a plain recut is the
                # delivered file, and this is the command every test pins.
                cmd += [*video_encode_args(QUALITY_FAST), *audio_encode_args()]
            else:
                af = ",".join(f for f in (_atempo_chain(speed), _loudnorm()) if f)
                cmd += ["-vf", f"setpts=PTS/{speed:g},fps={fps:g}", *video_encode_args(QUALITY_FAST),
                        "-af", af, "-ar", str(rate), *_audio_codec_args()]
            commands.append(cmd + _tail(part))

        elif kind == "hold":
            seconds = seg["ms"] / 1000.0
            fc = (f"[0:v]trim=end_frame=1,setpts=PTS-STARTPTS,"
                  f"tpad=stop_mode=clone:stop_duration={seconds:g},fps={fps:g}[v]")
            commands.append([
                "ffmpeg", "-y", "-ss", str(seg["at"]), "-i", input_path, *silence,
                "-filter_complex", fc, "-map", "[v]", "-map", "1:a",
                "-t", f"{seconds:g}", *video_encode_args(QUALITY_FAST),
                "-ar", str(rate), *_audio_codec_args(), *_tail(part)])

        elif kind == "image":
            path = asset_path(assets_dir, seg["src"])
            seconds = seg["ms"] / 1000.0
            frames = max(1, int(round(seconds * fps)))
            if os.path.splitext(path)[1].lower() == ".gif":
                # A GIF lives in IMAGE_EXTENSIONS but is not a still. Repeat it
                # for the insert's length (the output -t below ends the part)
                # and ignore zoom — a Ken Burns push over an animation is noise.
                fc = f"[0:v]{_fit_filter(width, height)},fps={fps:g}[v]"
                inputs = ["-ignore_loop", "0", "-i", path]
            elif seg.get("zoom"):
                fc = (f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
                      f"crop={width}:{height},zoompan=z='1+0.15*on/{frames}':d={frames}:"
                      f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={fps:g},"
                      f"format=yuv420p[v]")
                inputs = ["-i", path]
            else:
                fc = f"[0:v]{_fit_filter(width, height)}[v]"
                inputs = ["-loop", "1", "-framerate", f"{fps:g}", "-t", f"{seconds:g}", "-i", path]
            commands.append([
                "ffmpeg", "-y", *inputs, *silence,
                "-filter_complex", fc, "-map", "[v]", "-map", "1:a",
                "-t", f"{seconds:g}", "-r", f"{fps:g}", *video_encode_args(QUALITY_FAST),
                "-ar", str(rate), *_audio_codec_args(), *_tail(part)])

        else:  # clip
            path = asset_path(assets_dir, seg["src"])
            has_audio = bool((media.get("has_audio") or {}).get(path))
            cmd = ["ffmpeg", "-y", "-ss", str(seg["start"]), "-to", str(seg["end"]), "-i", path]
            if not has_audio:
                cmd += silence
            cmd += ["-filter_complex", f"[0:v]{_fit_filter(width, height)},fps={fps:g}[v]",
                    "-map", "[v]", "-map", "0:a" if has_audio else "1:a",
                    "-t", f"{float(seg['end']) - float(seg['start']):g}",
                    *video_encode_args(QUALITY_FAST), "-ar", str(rate),
                    *audio_encode_args(), *_tail(part)]
            commands.append(cmd)
    return commands


def concat_command(list_path, out_path):
    """Concat demuxer over identically-encoded parts — stream copy, no
    generation loss on the join."""
    return [
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", list_path, "-c", "copy",
        *METADATA_SCRUB, "-movflags", "+faststart", out_path,
    ]


def run_cut_concat(input_path, segments, out_path, workdir, runner=None,
                   assets_dir=None, media=None):
    """Cut every segment from ``input_path`` and join them into ``out_path``.
    ``assets_dir``/``media`` feed the insert kinds (see ``cut_commands``)."""
    run = runner or _run_ffmpeg
    if len(segments) == 1:
        run(cut_commands(input_path, segments, [out_path],
                         assets_dir=assets_dir, media=media)[0])
        return out_path

    # Unique per invocation: two concurrent recuts in the same job dir must
    # not overwrite each other's parts (or delete them via the finally below).
    token = uuid.uuid4().hex[:8]
    part_paths = [
        os.path.join(workdir, f"temp_recut_part_{token}_{i}.mp4")
        for i in range(len(segments))
    ]
    list_path = os.path.join(workdir, f"temp_recut_concat_{token}.txt")
    try:
        for command in cut_commands(input_path, segments, part_paths,
                                    assets_dir=assets_dir, media=media):
            run(command)
        with open(list_path, "w") as f:
            for part in part_paths:
                # Absolute paths: the concat demuxer resolves relative entries
                # against the LIST FILE's directory, not the process cwd.
                f.write(f"file '{os.path.abspath(part)}'\n")
        run(concat_command(list_path, out_path))
    finally:
        for path in part_paths + [list_path]:
            if os.path.exists(path):
                os.remove(path)
    return out_path


# Same ceiling as apply_watermark's: a hung ffmpeg must not pin the executor
# thread (and the caller's quota reservation) until a server restart.
FFMPEG_TIMEOUT_SECONDS = 1800


def _run_ffmpeg(command):
    try:
        result = subprocess.run(
            command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            timeout=FFMPEG_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"ffmpeg timed out after {FFMPEG_TIMEOUT_SECONDS}s ({command[1:6]}...)")
    if result.returncode != 0:
        tail = (result.stderr or b"").decode("utf-8", "replace")[-400:]
        raise RuntimeError(f"ffmpeg failed ({command[1:6]}...): {tail}")


def perform_recut(*, input_path, segments, output_dir, clean_name,
                  reframe=False, output_format="auto", watermark=False,
                  captions_transcript=None, force_strategy=None,
                  crop_overrides=None, runner=None, renderer=None,
                  watermarker=None, captioner=None, assets_dir=None,
                  prober=None):
    """Render a recut clip. Returns (served_filename, clean_filename).

    - ``assets_dir``: the job's uploaded-media folder that image/clip segments
      reference by bare file name.
    - ``prober``: ``path -> {'width','height','fps','has_audio'}``; defaults to
      ffprobe (``probe_media``) and is only called when the recipe has holds,
      inserts or speed changes. Tests inject it.

    - ``input_path``/``segments``: the file to cut from and the times ON THAT
      FILE (the caller rebases for the fast path).
    - ``reframe``: run the reframe engine on the joined cut (source path only —
      the canonical file is already framed).
    - ``watermark``: re-apply the free-plan watermark (source path only — the
      canonical file already carries it).
    - ``captions_transcript``: a clip-relative transcript (see
      ``virtual_transcript``); when given and non-empty, captions are burned
      LAST onto a ``subtitled_<ts>_`` derivative, preserving the invariant
      that the clean file stays clean for later re-styling.
    - ``crop_overrides``: scene index -> crop centre as a fraction of the
      source width, for scenes the user framed by hand. Source path only, for
      the same reason as ``reframe``: the canonical file is already cropped, so
      its framing can no longer be changed.

    The renderer/watermarker/captioner hooks default to main.py's
    implementations, imported lazily so this module stays importable without
    the ML stack; tests inject fakes.
    """
    # The uuid token keeps two same-second saves of one clip from writing (and
    # then serving) the same filename; the timestamp keeps "newest derived
    # file" resolution working in _canonical_clip_file.
    out_name = f"recut_{int(time.time())}_{uuid.uuid4().hex[:6]}_{clean_name}"
    out_path = os.path.join(output_dir, out_name)
    work_name = f"temp_{out_name}"
    work_path = os.path.join(output_dir, work_name)

    media = None
    if needs_fast_path(segments):
        probe = prober or probe_media
        media = dict(probe(input_path))
        media["has_audio"] = {}
        for seg in segments:
            if segment_kind(seg) == "clip":
                path = asset_path(assets_dir, seg["src"])
                media["has_audio"][path] = bool(probe(path).get("has_audio"))

    try:
        if media is None:
            # Plain recipe: keep the historical call shape (tests and callers
            # that stub run_cut_concat with the old signature stay valid).
            run_cut_concat(input_path, segments, work_path, output_dir,
                           runner=runner)
        else:
            run_cut_concat(input_path, segments, work_path, output_dir,
                           runner=runner, assets_dir=assets_dir, media=media)

        if reframe:
            if renderer is not None:
                render = renderer  # injected fakes keep the 3-arg contract
            else:
                main_render = _main_attr("render_clip")

                def render(i, o, f):
                    return main_render(i, o, f, force_strategy=force_strategy,
                                       crop_overrides=crop_overrides)
            if not render(work_path, out_path, output_format):
                raise RuntimeError("reframe failed on the recut clip")
        else:
            shutil.move(work_path, out_path)
            # No reframe means no fresh layout sidecar; the captions would fall
            # back to the bottom on a stacked clip. Carry the input's layout
            # ranges through the cut instead (empty when the input has none).
            import layout_ranges
            layout_ranges.write(out_path, [
                (r["start"], r["end"], r["layout"])
                for r in layout_ranges.remap(layout_ranges.read(input_path), segments)])

        if watermark:
            (watermarker or _main_attr("apply_watermark"))(out_path)

        served_name = out_name
        if captions_transcript and captions_transcript.get("segments"):
            caption = captioner or _main_attr("auto_caption_clip")
            captioned = caption(out_path, captions_transcript,
                                0.0, total_duration(segments))
            if captioned:
                served_name = os.path.basename(captioned)
        return served_name, out_name
    finally:
        if os.path.exists(work_path):
            os.remove(work_path)


def _main_attr(name):
    import main  # heavy — resolved only when a real render/caption runs
    return getattr(main, name)
