# Inline media overlays — design

**Problem.** Inserted media always takes the whole frame for its duration. To
show a logo while the speaker keeps talking there has to be a second mode:
the media composited *over* the running footage at a size and position the
editor chooses.

**Terms.** *Fill* is today's behaviour — the media becomes its own stretch of
the timeline and adds to the runtime. *Inline* is the new one — the media
sits on top of the footage and adds nothing to the runtime.

## Model

An inline overlay is not a segment; it is a property of the source footage
underneath it. It reuses the split-at-cut-points machinery that section slows
already use:

```json
{"start": 4.6, "end": 7.1, "overlay": {"src": "logo.png", "x": 0.06, "y": 0.72, "w": 0.28}}
```

- `x`, `y` — top-left of the box as a fraction of frame width/height.
- `w` — box width as a fraction of frame width; height follows the image's
  aspect ratio.
- Fractions, not pixels, so a recipe survives a reframe to another aspect.

Only `source` segments carry `overlay`. One overlay per segment: two overlays
across the same moment would need a compositing order the UI has no way to
express, so the first one wins, exactly as section speeds do.

Any accepted asset may ride inline — a still, an animated GIF/sticker, or a
video. A motion overlay is silent: only the footage's own audio track is
mapped, so nothing ever talks over the speaker underneath. `clip` inserts and
overlays are now the same set of files in two modes, and the editor converts
an edit between them without a re-upload.

## Limits (recut.py)

- `OVERLAY_W_MIN = 0.05`, `OVERLAY_W_MAX = 1.0` of frame width.
- `x`, `y` clamped to `0.0-1.0`; a box may run past the right or bottom edge
  and is cropped there, which is what dragging to an edge should do.
- `src` is any uploaded asset, resolved through `asset_path` like every other
  insert (bare names, known extension, no traversal).
- A source segment carrying an overlay still needs the fast path: the
  canonical clip is already framed, and the overlay's fractions are in that
  frame's terms.

## Render

A source part with an overlay is built with a filter graph instead of a plain
re-encode. Speed composes with it:

```
[0:v]setpts=PTS/{speed},fps={fps}[base];
[1:v]{setpts=PTS-STARTPTS,}scale={round(w*width)}:-2[ov];
[base][ov]overlay={round(x*width)}:{round(y*height)}[v]
```

`overlay`'s default `eof_action=repeat` holds a single still for the whole
part, so a still image input needs no `-loop`. `-2` keeps the scaled height
even, which `yuv420p` requires.

Motion overlays repeat instead of freezing, so a two-second sticker fills a
six-second window rather than holding its last frame:

| asset | input flags |
|---|---|
| still (`.png/.jpg/.jpeg/.webp`) | none — held by `eof_action=repeat` |
| `.gif` | `-ignore_loop 0` (otherwise the GIF's own loop count wins) |
| `.mp4`, `.mov` | `-stream_loop -1` |

Looping forever is bounded: the `overlay` filter emits EOF when its **main**
input ends, so the part is still the length of the footage under it.
`setpts=PTS-STARTPTS` on a looped input keeps its timestamps aligned with the
footage's. Only `0:a` is ever mapped, which is what drops a video overlay's
own soundtrack.

Durations do not change, so `virtual_transcript` and the caption re-timing
need no changes at all.

## Effects

Three optional fields, each defaulting to "do nothing" and each left out of
the recipe when it is the default:

| field | values | what it costs |
|---|---|---|
| `in` / `out` | `cut`, `fade`, `slide` | `fade` adds `format=rgba` + `fade`; `slide` is free |
| `motion` | `none`, `bounce`, `float`, `shake` | free |

**Motion and slides are overlay x/y expressions.** `overlay` re-evaluates them
per frame by default, and they can reference `overlay_w`/`overlay_h`, so the
box's real size never has to be known when the command is built. A slide comes
from whichever frame edge is nearest, so a badge in the corner arrives from
outside rather than across the speaker's face. The expressions go into the
graph single-quoted, because the commas inside `max()` would otherwise end the
filter early.

**A fade needs the overlay's own clock, and a still does not have one.** A
still overlay is normally held by `eof_action=repeat` for free — but a held
frame's PTS never advances, so `fade` read `t=0` forever and the overlay stayed
completely invisible. When a fade is requested, a still is instead looped into
a real timeline (`-loop 1 -framerate <fps> -t <duration>`). GIFs and videos
already advance and need nothing.

Transition length is `min(0.35 s, duration/3)`, so a 0.35 s entrance can never
still be arriving as a short overlay leaves.

No `pop` or `explode`: animating scale needs a per-frame scaler, and `zoompan`
— the only candidate — does not carry alpha, which is the one thing an overlay
cannot lose.

## Editing

The playhead sets where the overlay starts; it runs for a duration the editor
sets (default 2 s), and is placed by dragging a box on the preview — with the
box snapping to the frame's corners, edges and centre lines. Existing "insert
media" gains a fill/inline choice; fill is unchanged.
