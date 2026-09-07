# Timeline edits: pause, slow-down, image and clip inserts

Status: approved design, 2026-09-06 (local branch `local-hardening`).

## Goal

Let a user apply controlled timeline edits to a generated clip at exact points:
hold a frame for N ms, slow a range down, splice in a still image, splice in a
range of another video. Edits are specified as data (JSON), applied server-side,
and captions and hooks stay correctly timed afterwards. The dashboard UI and
the automatic recommender are explicitly later phases that write the same data.

## Where it lives: the existing clip recipe

Every clip already carries `recipe.segments`, a list of `{start, end}` source
ranges that `recut.py` concatenates, that `/api/recut` accepts, and that
`recut.virtual_transcript()` uses to re-time captions. This feature **extends
that segment model** instead of adding a second edit format:

| kind | fields | meaning |
|---|---|---|
| `source` (default when `kind` is absent) | `start`, `end`, optional `speed` (0.25–4.0, default 1.0) | a range of the source, optionally time-stretched (video + pitch-corrected audio) |
| `hold` | `at`, `ms` (40–3000) | freeze the source frame at `at` for `ms`, silent |
| `image` | `src`, `ms` (200–10000), optional `zoom` (bool, Ken Burns) | a still, scaled/padded to 1080×1920, silent |
| `clip` | `src`, `start`, `end` | a range of another video under the job's assets, scaled/padded to 1080×1920, with its own audio |

Segments play in list order. A 100 ms pause after the word "Instagram" is
therefore `[{source 0→15.68}, {hold at 15.68 ms 100}, {source 15.68→20.96}]`.
Old recipes (plain `{start,end}` lists) are valid unchanged.

`src` is a file name resolved **only** under `output/<job_id>/assets/`; any
other path or a traversal is rejected with a 400. Assets are uploaded with a
new `PUT /api/jobs/{job_id}/assets/{name}` (raw bytes, size-capped, extension
allow-list: png jpg jpeg webp gif mp4 mov).

Overlays (an insert playing *over* the footage) are out of scope; every insert
is a cutaway that lengthens the timeline.

## Rendering

`recut.cut_commands()` grows a per-kind branch. Every part is encoded with the
same parameters the existing branch already uses (1080×1920, same fps,
`video_encode_args(QUALITY_FAST)`, `audio_encode_args()`, metadata scrub) so
the existing stream-copy concat keeps working:

- `source` with speed ≠ 1: `setpts=PTS/speed` on video, chained `atempo`
  factors on audio (each within 0.5–2.0).
- `hold`: `-ss at -frames:v 1` looped for `ms` (`-loop 1 -t`), plus a generated
  silent audio track (`anullsrc`) of the same length.
- `image`: `-loop 1 -t ms` over the still, `scale` + `pad` to 1080×1920, optional
  `zoompan` (the AI Shorts Ken Burns filter), `anullsrc` audio.
- `clip`: `-ss start -to end` on the asset, `scale` + `pad` to 1080×1920, its
  audio resampled to the common rate.

Fast vs source path: `hold`, `image`, `clip` never need the original source
video. A `source` segment follows the existing rule (fast when inside the
canonical range, otherwise cut from the source and re-reframed).

## Timing

`recut.total_duration()` sums per kind: `(end-start)/speed`, `ms/1000`, or
`end-start`. `recut.virtual_transcript()` keeps its shape; non-source segments
contribute no words and advance the offset, and a slowed source segment
scales each word's offsets by `1/speed`. Because `/api/subtitle`, the hook
overlay and the pipeline's auto-caption pass already run against this virtual
transcript, captions and hooks land at the right moments without further
changes to them.

## Validation (`recut.normalize_segments`)

Kind-aware. Rejects unknown kinds, out-of-range `speed`/`ms`, a `hold.at`
outside the source, `clip.start >= clip.end`, `src` outside the assets folder
or with a disallowed extension, more than `MAX_SEGMENTS` (raised 12 → 24)
segments, or a total over `MAX_TOTAL_SECONDS`. Errors are `RecutError` and
surface verbatim as 400s, as today.

## Surfaces

- `/api/recut` and `GET /api/clip/{job}/{idx}/edl`: unchanged contracts, now
  accepting/returning the richer segments. The EDL response gains a `kinds`
  list so a future UI knows what the server supports.
- `PUT /api/jobs/{job_id}/assets/{name}` (new) and
  `GET /api/jobs/{job_id}/assets` (list).
- CLI: `openshorts recut <job_id> <clip_index> --edl edits.json [--asset file …]`
  uploads assets then posts the recipe.
- MCP: `recut_clip` already takes segments; no change beyond the schema text.

## Files

`recut.py` (segment kinds, commands, durations, transcript), `app.py`
(validation wiring, assets endpoints, EDL `kinds`), `cli/openshorts_cli.py`
(`recut` command), `tests/test_recut.py` (+ new cases), `tests/test_assets.py`
(new). No dashboard files in this phase.

## Testing

- Unit, no FFmpeg: normalization accepts/rejects each rule above; durations
  per kind; `virtual_transcript` word placement across hold/image/clip and a
  0.5× slow segment; command builders emit the expected filters and never
  reference a path outside the assets dir.
- End to end (manual, documented in the vault note): the Rea clip with a 100 ms
  hold after "Instagram", a 0.6× stretch over "10% descuento", a 1.2 s Rea logo
  still, and a 1.5 s clip insert; assert output duration = source + inserts +
  stretch delta (±1 frame) and that captions still align by eye.

## Later phases (not this spec)

Overlay mode, speed ramps, dashboard scrubber/markers UI, and the automatic
B-roll recommender emitting these segments.
