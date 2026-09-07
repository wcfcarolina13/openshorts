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

Images only for now. A video overlay means a second video stream and a
decision about its audio; `clip` inserts stay fill-only.

## Limits (recut.py)

- `OVERLAY_W_MIN = 0.05`, `OVERLAY_W_MAX = 1.0` of frame width.
- `x`, `y` clamped to `0.0-1.0`; a box may run past the right or bottom edge
  and is cropped there, which is what dragging to an edge should do.
- `src` must be an image asset, resolved through `asset_path` like every
  other insert (bare names, no traversal).
- A source segment carrying an overlay still needs the fast path: the
  canonical clip is already framed, and the overlay's fractions are in that
  frame's terms.

## Render

A source part with an overlay is built with a filter graph instead of a plain
re-encode. Speed composes with it:

```
[0:v]setpts=PTS/{speed},fps={fps}[base];
[1:v]scale={round(w*width)}:-2[ov];
[base][ov]overlay={round(x*width)}:{round(y*height)}[v]
```

`overlay`'s default `eof_action=repeat` holds a single still for the whole
part, so the image input needs no `-loop`. `-2` keeps the scaled height even,
which `yuv420p` requires.

Durations do not change, so `virtual_transcript` and the caption re-timing
need no changes at all.

## Editing

The playhead sets where the overlay starts; it runs for a duration the editor
sets (default 2 s), and is placed by dragging a box on the preview — with the
box snapping to the frame's corners, edges and centre lines. Existing "insert
media" gains a fill/inline choice; fill is unchanged.
