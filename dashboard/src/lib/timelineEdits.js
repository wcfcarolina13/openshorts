// Pure helpers for the timeline-edits modal: turn a list of human edits
// (pause / slow / insert, anchored on SOURCE seconds) into the recipe
// segments the backend renders, and back. No React, no I/O — unit-tested
// with `node --test src/lib/timelineEdits.test.js`.
//
// Segment kinds and limits mirror recut.py (see
// docs/superpowers/specs/2026-09-06-timeline-edits-design.md).

export const MIN_SEGMENT_SECONDS = 0.5;

const round3 = (x) => Math.round(x * 1000) / 1000;

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
 * Returns recipe segments in timeline order.
 */
export function compileSegments(baseSegments, edits) {
  const out = [];
  for (const range of baseSegments) {
    const a = range.start;
    const b = range.end;
    const inside = (t) => t >= a && t <= b;
    const cuts = new Set([a, b]);
    const events = [];
    for (const e of edits) {
      if (e.type === 'slow') {
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
    // items: source pieces interleaved with the events anchored at each point.
    const items = [];
    points.forEach((p, i) => {
      for (const e of events) if (e.at === p) items.push({ event: eventSegment(e) });
      if (i < points.length - 1) {
        const q = points[i + 1];
        const piece = { start: p, end: q };
        const speed = speedAt((p + q) / 2);
        if (speed !== 1) piece.speed = speed;
        items.push({ piece });
      }
    });
    // Slivers shorter than the minimum merge into a neighbouring source piece
    // (next first, so an event at the very start lands before the footage).
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (!it.piece || it.piece.end - it.piece.start >= MIN_SEGMENT_SECONDS) continue;
      const next = items.slice(i + 1).find((x) => x.piece);
      const prev = items.slice(0, i).reverse().find((x) => x.piece);
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

/** Inverse of compileSegments, so reopening a clip shows its existing edits. */
export function parseRecipe(segments) {
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
      if (seg.speed && seg.speed !== 1) {
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
  return { base, edits };
}
