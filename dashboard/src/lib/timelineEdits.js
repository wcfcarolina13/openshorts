// Pure helpers for the timeline-edits modal: turn a list of human edits
// (pause / slow / insert, anchored on SOURCE seconds) into the recipe
// segments the backend renders, and back. No React, no I/O — unit-tested
// with `node --test src/lib/timelineEdits.test.js`.
//
// Segment kinds and limits mirror recut.py (see
// docs/superpowers/specs/2026-09-06-timeline-edits-design.md).

export const MIN_SEGMENT_SECONDS = 0.5;
// Mirrors recut.py: the renderer refuses anything outside these.
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
export const MAX_TOTAL_SECONDS = 180;
// Mirrors recut.py. The first entry of each list is the default, and a default
// is left out of the recipe so a plain overlay stays the three numbers it was.
export const OVERLAY_TRANSITIONS = ['cut', 'fade', 'slide'];
export const OVERLAY_MOTIONS = ['none', 'bounce', 'float', 'shake'];

const round3 = (x) => Math.round(x * 1000) / 1000;
const clampSpeed = (x) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, round3(x)));

const isSource = (seg) => !seg.kind || seg.kind === 'source';

export function segmentDuration(seg) {
  if (isSource(seg)) return (seg.end - seg.start) / (seg.speed || 1);
  if (seg.kind === 'hold' || seg.kind === 'image') return seg.ms / 1000;
  return seg.end - seg.start; // clip
}

export function totalDuration(segments) {
  return round3(segments.reduce((sum, s) => sum + segmentDuration(s), 0));
}

/** Seconds on the rendered clip for source time `t` (before any event at t). */
export function sourceToRendered(t, segments) {
  let offset = 0;
  for (const seg of segments) {
    if (isSource(seg) && t >= seg.start && t <= seg.end) {
      return round3(offset + (t - seg.start) / (seg.speed || 1));
    }
    offset += segmentDuration(seg);
  }
  return round3(offset);
}

/** Source time for rendered time `r`; inside a hold/insert, its anchor. */
export function renderedToSource(r, segments) {
  let offset = 0;
  let lastSourceEnd = null;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const d = segmentDuration(seg);
    if (r <= offset + d + 1e-9) {
      if (isSource(seg)) return round3(seg.start + (r - offset) * (seg.speed || 1));
      if (seg.kind === 'hold') return seg.at;
      if (lastSourceEnd !== null) return lastSourceEnd;
      const next = segments.slice(i + 1).find(isSource);
      return next ? next.start : 0;
    }
    if (isSource(seg)) lastSourceEnd = seg.end;
    offset += d;
  }
  return lastSourceEnd ?? 0;
}

function eventSegment(edit) {
  if (edit.type === 'pause') return { kind: 'hold', at: edit.at, ms: edit.ms };
  if (edit.kind === 'clip') return { kind: 'clip', src: edit.src, start: edit.start, end: edit.end };
  const seg = { kind: 'image', src: edit.src, ms: edit.ms };
  if (edit.zoom) seg.zoom = true;
  return seg;
}

/**
 * baseSegments: the clip's source ranges ({start,end}, speed ignored).
 * edits: [{type:'pause', at, ms} | {type:'slow', from, to, factor} |
 *         {type:'insert', at, kind, src, ms?, zoom?, start?, end?}]
 * globalSpeed: rate for the whole clip; a section slow multiplies with it,
 *   and the product is clamped to what the renderer accepts.
 * Returns recipe segments in timeline order.
 */
export function compileSegments(baseSegments, edits, globalSpeed = 1) {
  const out = [];
  for (const range of baseSegments) {
    const a = range.start;
    const b = range.end;
    const inside = (t) => t >= a && t <= b;
    const cuts = new Set([a, b]);
    const events = [];
    for (const e of edits) {
      if (e.type === 'slow' || e.type === 'overlay') {
        const from = Math.max(a, e.from);
        const to = Math.min(b, e.to);
        if (to > from) { cuts.add(from); cuts.add(to); }
      } else if (inside(e.at)) {
        cuts.add(e.at);
        events.push(e);
      }
    }
    const points = [...cuts].sort((x, y) => x - y);
    const speedAt = (mid) => {
      const slow = edits.find((e) => e.type === 'slow' && mid > e.from && mid < e.to);
      return slow ? slow.factor : 1;
    };
    // One overlay per piece: two stacked over the same moment would need a
    // compositing order the editor has no way to express, so the first wins.
    const overlayAt = (mid) => {
      const o = edits.find((e) => e.type === 'overlay' && mid > e.from && mid < e.to);
      if (!o) return null;
      // Listed field by field on purpose: an edit also carries id/type/from/to,
      // which must never reach the recipe. Anything added to an overlay has to
      // be added HERE too, or it is dropped in silence.
      const box = { src: o.src, x: o.x, y: o.y, w: o.w };
      if (o.in && o.in !== OVERLAY_TRANSITIONS[0]) box.in = o.in;
      if (o.out && o.out !== OVERLAY_TRANSITIONS[0]) box.out = o.out;
      if (o.motion && o.motion !== OVERLAY_MOTIONS[0]) box.motion = o.motion;
      return box;
    };
    // items: source pieces interleaved with the events anchored at each point.
    const items = [];
    points.forEach((p, i) => {
      for (const e of events) if (e.at === p) items.push({ event: eventSegment(e) });
      if (i < points.length - 1) {
        const q = points[i + 1];
        const piece = { start: p, end: q };
        const speed = clampSpeed(speedAt((p + q) / 2) * globalSpeed);
        if (speed !== 1) piece.speed = speed;
        const overlay = overlayAt((p + q) / 2);
        if (overlay) piece.overlay = overlay;
        items.push({ piece });
      }
    });
    // Slivers shorter than the minimum merge into a neighbouring source piece
    // (next first, so an event at the very start lands before the footage).
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (!it.piece || it.piece.end - it.piece.start >= MIN_SEGMENT_SECONDS) continue;
      const sameLook = (x) => JSON.stringify(x.piece.overlay || null)
        === JSON.stringify(it.piece.overlay || null) && (x.piece.speed || 1) === (it.piece.speed || 1);
      const next = items.slice(i + 1).find((x) => x.piece && sameLook(x));
      const prev = items.slice(0, i).reverse().find((x) => x.piece && sameLook(x));
      if (next) next.piece.start = it.piece.start;
      else if (prev) prev.piece.end = it.piece.end;
      else continue; // lone tiny range: keep it, the server will reject it
      items.splice(i, 1);
      i -= 1;
    }
    for (const it of items) out.push(it.piece || it.event);
  }
  return out;
}

let nextId = 1;
const newId = () => `e${Date.now().toString(36)}${(nextId += 1)}`;

/**
 * Inverse of compileSegments, so reopening a clip shows its existing edits.
 *
 * A speed shared by every source segment reads back as the clip's global
 * speed. Mixed speeds cannot be split into "global x section" without
 * guessing, so they all come back as section slows at global 1 — the same
 * render either way, just a different way of describing it.
 */
export function parseRecipe(segments) {
  const sourceSpeeds = segments.filter(isSource).map((s) => s.speed || 1);
  const globalSpeed = sourceSpeeds.length
    && sourceSpeeds.every((s) => Math.abs(s - sourceSpeeds[0]) < 1e-6)
    ? sourceSpeeds[0] : 1;
  const base = [];
  const edits = [];
  let lastSourceEnd = null;
  let pendingInserts = [];
  const flushInserts = (anchor) => {
    for (const ins of pendingInserts) edits.push({ ...ins, at: anchor });
    pendingInserts = [];
  };
  for (const seg of segments) {
    if (isSource(seg)) {
      if (pendingInserts.length) flushInserts(lastSourceEnd ?? seg.start);
      const last = base[base.length - 1];
      if (last && last.end === seg.start) last.end = seg.end;
      else base.push({ start: seg.start, end: seg.end });
      if (seg.overlay) {
        const prev = edits.filter((e) => e.type === 'overlay').pop();
        const same = (k, d) => (prev?.[k] ?? d) === (seg.overlay[k] ?? d);
        if (prev && prev.to === seg.start && prev.src === seg.overlay.src
            && prev.x === seg.overlay.x && prev.y === seg.overlay.y
            && prev.w === seg.overlay.w
            && same('in', OVERLAY_TRANSITIONS[0]) && same('out', OVERLAY_TRANSITIONS[0])
            && same('motion', OVERLAY_MOTIONS[0])) prev.to = seg.end;
        else edits.push({ id: newId(), type: 'overlay', from: seg.start, to: seg.end, ...seg.overlay });
      }
      if (seg.speed && seg.speed !== 1 && globalSpeed === 1) {
        const prevSlow = edits[edits.length - 1];
        if (prevSlow && prevSlow.type === 'slow' && prevSlow.to === seg.start
            && prevSlow.factor === seg.speed) prevSlow.to = seg.end;
        else edits.push({ id: newId(), type: 'slow', from: seg.start, to: seg.end, factor: seg.speed });
      }
      lastSourceEnd = seg.end;
    } else if (seg.kind === 'hold') {
      edits.push({ id: newId(), type: 'pause', at: seg.at, ms: seg.ms });
    } else if (seg.kind === 'image') {
      const ins = { id: newId(), type: 'insert', kind: 'image', src: seg.src, ms: seg.ms };
      if (seg.zoom) ins.zoom = true;
      pendingInserts.push(ins);
    } else if (seg.kind === 'clip') {
      pendingInserts.push({ id: newId(), type: 'insert', kind: 'clip', src: seg.src, start: seg.start, end: seg.end });
    }
  }
  if (pendingInserts.length) flushInserts(lastSourceEnd ?? 0);
  return { base, edits, globalSpeed };
}
