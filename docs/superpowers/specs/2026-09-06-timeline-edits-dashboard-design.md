# Timeline edits in the dashboard

Status: approved design, 2026-09-06 (phase 2 of the timeline-edits feature;
backend in `2026-09-06-timeline-edits-design.md`).

## Goal

"Super easy" editing: from a finished clip, add a pause, slow a passage, or
splice in an image / part of another video, without JSON or the CLI. One
modal, three big actions, chips you can delete, one apply button.

## Shape

A new **`TimelineEditsModal`** (`dashboard/src/components/TimelineEditsModal.jsx`)
opened from a **"timeline"** button on the result card, next to "edit clip".
The trim editor (`ClipEditor.jsx`, 1.6k lines) stays untouched; both write the
same recipe through `POST /api/clip/rerender`, so a trim and a timeline edit
never fight: the modal loads the clip's current recipe, keeps its source
ranges as the base, and layers edits on top.

Layout (Modal `xl`, eyebrow `EDITOR · TIMELINE`, title `timeline edits`):

- **Left:** the clip's current video with native controls. Under it a
  **source timeline bar** (0 → clip's canonical span) with a draggable
  playhead and coloured markers for every edit, and a horizontally scrolling
  row of **word chips** from the transcript; clicking a word puts the playhead
  at that word's end (the natural "pause after X" anchor) and seeks the video
  to the matching point of the rendered clip.
- **Right, top:** the readout `at 0:15.7 · after "Instagram"` and three large
  buttons: **pause here**, **slow down**, **insert media**.
- **Right, middle:** the edits list as chips, newest last, each with its
  minimal controls and a delete: pause → ms stepper (40–3000, default 100);
  slow → `to` word/time and a factor segmented control (0.5× 0.75× 1.5× 2×,
  default 0.5×, range 0.25–4 via the EDL limits); image → duration stepper
  (default 1200 ms) + zoom toggle; clip → start/end within the asset (default
  first 2 s).
- **Right, bottom:** total duration readout (`24.5 s, +3.6 s`), **apply**
  (spinner with elapsed seconds, same pattern as the trim editor), cancel.

**insert media** opens the OS file picker (png jpg jpeg webp gif mp4 mov),
uploads immediately to `PUT /api/jobs/{job}/assets/{name}` with a progress
state, and adds the chip; previously uploaded assets for the job are listed
from `GET /api/jobs/{job}/assets` for reuse.

## Data

`dashboard/src/lib/timelineEdits.js` (pure, no React, unit-tested with
`node --test`):

- `edit` objects: `{id, type: 'pause'|'slow'|'insert', at, ms}`,
  `{…type:'slow', from, to, factor}`, `{…type:'insert', at, src, kind:'image'|'clip', ms?, zoom?, start?, end?}`.
- `compileSegments(baseSegments, edits)` → recipe segments. Base = the current
  recipe's source ranges (speed stripped). Within each base range, cut points
  are every edit anchor inside it; between cuts emit `{start,end[,speed]}`
  (speed when inside a slow range), at a pause anchor emit `hold`, at an
  insert anchor emit `image`/`clip`. Anchors outside every base range are
  ignored. Sub-`MIN_SEGMENT_SECONDS` slivers merge into their neighbour.
- `parseRecipe(segments)` → `{base, edits}` (inverse, so reopening shows the
  existing edits): consecutive source segments that share a speed ≠ 1 become
  one slow edit; `hold` → pause at its `at`; `image`/`clip` → insert anchored
  at the end of the preceding source segment.
- `sourceToRendered(t, segments)` → seconds on the rendered clip, for seeking
  the preview.
- `totalDuration(segments)` mirrors the backend's rule.

## Validation and errors

Client mirrors the EDL `limits` (kinds, speed, hold_ms, image_ms,
max_segments); the server stays authoritative and its 400 `detail` is shown
verbatim under the apply button. Overlapping slow ranges are prevented at
creation (a new slow snaps its `from` to the end of the previous one).

## Files

Create `TimelineEditsModal.jsx`, `lib/timelineEdits.js`,
`lib/timelineEdits.test.js`. Modify `ResultCard.jsx` (button + prop),
`App.jsx` (open state, mount, reuse `handleClipRerendered`).

## Testing

`node --test` on the compile/parse/seek helpers (round-trip, splitting, sliver
merge, ordering). ESLint clean. Manual: open the modal on the Rea clip,
reproduce the CLI edit list through the UI, apply, confirm the same recipe is
persisted and the preview updates; reopen and see the chips restored.

## Out of scope

Overlay mode, speed ramps, drag-to-resize markers, the auto-recommender.
