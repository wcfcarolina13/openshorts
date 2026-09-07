// node --test dashboard/src/lib/timelineEdits.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileSegments,
  parseRecipe,
  sourceToRendered,
  totalDuration,
  MIN_SEGMENT_SECONDS,
  SPEED_MIN,
  SPEED_MAX,
  nearestEdge,
  overlayPreviewStyle,
} from './timelineEdits.js';

const base = [{ start: 0, end: 20.957 }];

test('no edits returns the base untouched', () => {
  assert.deepEqual(compileSegments(base, []), [{ start: 0, end: 20.957 }]);
});

test('pause splits the base and emits a hold at the anchor', () => {
  const segs = compileSegments(base, [{ id: 'a', type: 'pause', at: 15.68, ms: 100 }]);
  assert.deepEqual(segs, [
    { start: 0, end: 15.68 },
    { kind: 'hold', at: 15.68, ms: 100 },
    { start: 15.68, end: 20.957 },
  ]);
});

test('slow range becomes a sped source segment between plain ones', () => {
  const segs = compileSegments(base, [{ id: 's', type: 'slow', from: 15.68, to: 19.1, factor: 0.6 }]);
  assert.deepEqual(segs, [
    { start: 0, end: 15.68 },
    { start: 15.68, end: 19.1, speed: 0.6 },
    { start: 19.1, end: 20.957 },
  ]);
});

test('insert image at an anchor, ordered with a pause and a slow', () => {
  const edits = [
    { id: 'p', type: 'pause', at: 15.68, ms: 100 },
    { id: 's', type: 'slow', from: 15.68, to: 19.1, factor: 0.6 },
    { id: 'i', type: 'insert', at: 19.1, kind: 'image', src: 'logo.png', ms: 1200, zoom: true },
  ];
  assert.deepEqual(compileSegments(base, edits), [
    { start: 0, end: 15.68 },
    { kind: 'hold', at: 15.68, ms: 100 },
    { start: 15.68, end: 19.1, speed: 0.6 },
    { kind: 'image', src: 'logo.png', ms: 1200, zoom: true },
    { start: 19.1, end: 20.957 },
  ]);
});

test('anchor at the very end appends after the last piece; outside anchors are ignored', () => {
  const segs = compileSegments(base, [
    { id: 'p', type: 'pause', at: 20.957, ms: 200 },
    { id: 'x', type: 'pause', at: 25, ms: 200 },
  ]);
  assert.deepEqual(segs, [{ start: 0, end: 20.957 }, { kind: 'hold', at: 20.957, ms: 200 }]);
});

test('slivers shorter than the minimum merge into their neighbour', () => {
  const segs = compileSegments(base, [{ id: 'p', type: 'pause', at: 0.2, ms: 100 }]);
  assert.deepEqual(segs, [{ kind: 'hold', at: 0.2, ms: 100 }, { start: 0, end: 20.957 }]);
  assert.ok(MIN_SEGMENT_SECONDS === 0.5);
});

test('clip insert carries its asset range', () => {
  const segs = compileSegments(base, [
    { id: 'c', type: 'insert', at: 10, kind: 'clip', src: 'b.mp4', start: 1, end: 3 },
  ]);
  assert.deepEqual(segs[1], { kind: 'clip', src: 'b.mp4', start: 1, end: 3 });
});

test('parseRecipe inverts compileSegments', () => {
  const edits = [
    { id: 'p', type: 'pause', at: 15.68, ms: 100 },
    { id: 's', type: 'slow', from: 15.68, to: 19.1, factor: 0.6 },
    { id: 'i', type: 'insert', at: 19.1, kind: 'image', src: 'logo.png', ms: 1200, zoom: true },
  ];
  const parsed = parseRecipe(compileSegments(base, edits));
  assert.deepEqual(parsed.base, [{ start: 0, end: 20.957 }]);
  const strip = (e) => { const { id: _id, ...rest } = e; return rest; };
  assert.deepEqual(parsed.edits.map(strip), edits.map(strip));
  assert.deepEqual(compileSegments(parsed.base, parsed.edits), compileSegments(base, edits));
});

test('parseRecipe keeps trims as separate base ranges', () => {
  const parsed = parseRecipe([{ start: 2, end: 8 }, { start: 12, end: 20 }]);
  assert.deepEqual(parsed, { base: [{ start: 2, end: 8 }, { start: 12, end: 20 }], edits: [], globalSpeed: 1 });
});

test('totalDuration and sourceToRendered follow the timeline', () => {
  const segs = compileSegments(base, [
    { id: 'p', type: 'pause', at: 15.68, ms: 100 },
    { id: 's', type: 'slow', from: 15.68, to: 19.1, factor: 0.6 },
    { id: 'i', type: 'insert', at: 19.1, kind: 'image', src: 'logo.png', ms: 1200 },
  ]);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-3, `${a} vs ${b}`);
  assert.equal(totalDuration(segs), 24.537);
  near(sourceToRendered(10, segs), 10);
  near(sourceToRendered(15.68, segs), 15.68);
  near(sourceToRendered(17.39, segs), 15.68 + 0.1 + (17.39 - 15.68) / 0.6);
  near(sourceToRendered(20, segs), 15.68 + 0.1 + 3.42 / 0.6 + 1.2 + 0.9);
});

test('renderedToSource inverts sourceToRendered and maps inserts to their anchor', async () => {
  const { renderedToSource } = await import('./timelineEdits.js');
  const segs = compileSegments(base, [
    { id: 'p', type: 'pause', at: 15.68, ms: 100 },
    { id: 's', type: 'slow', from: 15.68, to: 19.1, factor: 0.6 },
    { id: 'i', type: 'insert', at: 19.1, kind: 'image', src: 'logo.png', ms: 1200 },
  ]);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-3, `${a} vs ${b}`);
  near(renderedToSource(10, segs), 10);
  near(renderedToSource(15.73, segs), 15.68);           // inside the hold
  near(renderedToSource(sourceToRendered(17.39, segs), segs), 17.39);
  near(renderedToSource(15.68 + 0.1 + 5.7 + 0.5, segs), 19.1); // inside the image
  near(renderedToSource(sourceToRendered(20, segs), segs), 20);
});

test('a global speed slows every source piece and nothing else', () => {
  const segs = compileSegments(base, [
    { id: 'p', type: 'pause', at: 10, ms: 100 },
    { id: 'i', type: 'insert', at: 10, kind: 'image', src: 'logo.png', ms: 1200 },
  ], 0.5);
  assert.deepEqual(segs, [
    { start: 0, end: 10, speed: 0.5 },
    { kind: 'hold', at: 10, ms: 100 },
    { kind: 'image', src: 'logo.png', ms: 1200 },
    { start: 10, end: 20.957, speed: 0.5 },
  ]);
});

test('a global speed of 1 leaves the segments untouched', () => {
  assert.deepEqual(compileSegments(base, [], 1), [{ start: 0, end: 20.957 }]);
});

test('a section slow multiplies with the global speed', () => {
  const segs = compileSegments(base, [
    { id: 's', type: 'slow', from: 5, to: 10, factor: 0.5 },
  ], 0.5);
  assert.deepEqual(segs, [
    { start: 0, end: 5, speed: 0.5 },
    { start: 5, end: 10, speed: 0.25 },
    { start: 10, end: 20.957, speed: 0.5 },
  ]);
});

test('the product of global and section speed is clamped to what recut accepts', () => {
  const slow = compileSegments(base, [{ id: 's', type: 'slow', from: 5, to: 10, factor: 0.5 }], 0.25);
  assert.equal(slow[1].speed, SPEED_MIN);
  const fast = compileSegments(base, [{ id: 's', type: 'slow', from: 5, to: 10, factor: 2 }], 4);
  assert.equal(fast[1].speed, SPEED_MAX);
});

test('global speed stretches the total duration', () => {
  const half = compileSegments(base, [], 0.5);
  assert.ok(Math.abs(totalDuration(half) - 20.957 * 2) < 1e-3, totalDuration(half));
});

test('parseRecipe recovers a global speed when every source segment shares it', () => {
  const segs = compileSegments(base, [{ id: 'p', type: 'pause', at: 10, ms: 100 }], 0.5);
  const parsed = parseRecipe(segs);
  assert.equal(parsed.globalSpeed, 0.5);
  assert.deepEqual(parsed.base, [{ start: 0, end: 20.957 }]);
  assert.deepEqual(parsed.edits.map((e) => e.type), ['pause']);
});

test('parseRecipe round-trips a globally slowed clip', () => {
  const segs = compileSegments(base, [{ id: 'p', type: 'pause', at: 10, ms: 100 }], 0.5);
  const parsed = parseRecipe(segs);
  assert.deepEqual(compileSegments(parsed.base, parsed.edits, parsed.globalSpeed), segs);
});

test('mixed speeds stay section slows at global 1, so the render is unchanged', () => {
  const segs = compileSegments(base, [{ id: 's', type: 'slow', from: 5, to: 10, factor: 0.5 }], 1);
  const parsed = parseRecipe(segs);
  assert.equal(parsed.globalSpeed, 1);
  assert.deepEqual(compileSegments(parsed.base, parsed.edits, parsed.globalSpeed), segs);
});

const LOGO = { src: 'logo.png', x: 0.06, y: 0.72, w: 0.28 };

test('an inline overlay rides on the source pieces it covers', () => {
  const segs = compileSegments(base, [{ id: 'o', type: 'overlay', from: 5, to: 9, ...LOGO }]);
  assert.deepEqual(segs, [
    { start: 0, end: 5 },
    { start: 5, end: 9, overlay: LOGO },
    { start: 9, end: 20.957 },
  ]);
});

test('an inline overlay adds no running time', () => {
  const segs = compileSegments(base, [{ id: 'o', type: 'overlay', from: 5, to: 9, ...LOGO }]);
  assert.equal(totalDuration(segs), totalDuration(base));
});

test('an overlay and a slow over the same range ride on one piece', () => {
  const segs = compileSegments(base, [
    { id: 's', type: 'slow', from: 5, to: 9, factor: 0.5 },
    { id: 'o', type: 'overlay', from: 5, to: 9, ...LOGO },
  ]);
  assert.deepEqual(segs[1], { start: 5, end: 9, speed: 0.5, overlay: LOGO });
});

test('overlapping overlays: the first one wins, as speeds do', () => {
  const other = { src: 'b.png', x: 0, y: 0, w: 0.5 };
  const segs = compileSegments(base, [
    { id: 'o1', type: 'overlay', from: 5, to: 9, ...LOGO },
    { id: 'o2', type: 'overlay', from: 6, to: 8, ...other },
  ]);
  assert.deepEqual(segs.filter((x) => x.overlay).map((x) => x.overlay.src),
    ['logo.png', 'logo.png', 'logo.png']);
});

test('parseRecipe reads overlays back and merges the pieces they span', () => {
  const segs = compileSegments(base, [
    { id: 'p', type: 'pause', at: 7, ms: 100 },
    { id: 'o', type: 'overlay', from: 5, to: 9, ...LOGO },
  ]);
  const parsed = parseRecipe(segs);
  const overlays = parsed.edits.filter((e) => e.type === 'overlay');
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0].from, 5);
  assert.equal(overlays[0].to, 9);
  assert.equal(overlays[0].src, 'logo.png');
  assert.equal(overlays[0].w, 0.28);
});

test('parseRecipe round-trips a clip with an overlay', () => {
  const segs = compileSegments(base, [{ id: 'o', type: 'overlay', from: 5, to: 9, ...LOGO }]);
  const parsed = parseRecipe(segs);
  assert.deepEqual(compileSegments(parsed.base, parsed.edits, parsed.globalSpeed), segs);
});

test('two different overlays stay two edits', () => {
  const segs = compileSegments(base, [
    { id: 'o1', type: 'overlay', from: 3, to: 5, ...LOGO },
    { id: 'o2', type: 'overlay', from: 9, to: 12, src: 'b.png', x: 0.5, y: 0.1, w: 0.2 },
  ]);
  assert.equal(parseRecipe(segs).edits.filter((e) => e.type === 'overlay').length, 2);
});

test('overlay effects reach the recipe, and defaults stay out of it', () => {
  const base = [{ start: 0, end: 10 }];
  const plain = compileSegments(base, [{
    id: 'a', type: 'overlay', from: 2, to: 5, src: 'logo.png', x: 0.1, y: 0.2, w: 0.3,
    in: 'cut', out: 'cut', motion: 'none',
  }]);
  assert.deepEqual(plain[1].overlay, { src: 'logo.png', x: 0.1, y: 0.2, w: 0.3 });

  const fancy = compileSegments(base, [{
    id: 'a', type: 'overlay', from: 2, to: 5, src: 'logo.png', x: 0.1, y: 0.2, w: 0.3,
    in: 'fade', out: 'slide', motion: 'bounce',
  }]);
  assert.deepEqual(fancy[1].overlay, {
    src: 'logo.png', x: 0.1, y: 0.2, w: 0.3, in: 'fade', out: 'slide', motion: 'bounce',
  });
});

test('parseRecipe brings the effects back', () => {
  const overlay = { src: 'logo.png', x: 0.1, y: 0.2, w: 0.3, in: 'fade', motion: 'shake' };
  const { edits } = parseRecipe([
    { start: 0, end: 2 },
    { start: 2, end: 5, overlay },
    { start: 5, end: 10 },
  ]);
  const o = edits.find((e) => e.type === 'overlay');
  assert.equal(o.from, 2);
  assert.equal(o.to, 5);
  assert.equal(o.in, 'fade');
  assert.equal(o.motion, 'shake');
});

test('two overlays that differ only in their effects stay two edits', () => {
  const { edits } = parseRecipe([
    { start: 0, end: 2, overlay: { src: 'a.png', x: 0, y: 0, w: 0.2, motion: 'bounce' } },
    { start: 2, end: 4, overlay: { src: 'a.png', x: 0, y: 0, w: 0.2 } },
  ]);
  assert.equal(edits.filter((e) => e.type === 'overlay').length, 2);
});

test('an edit round-trips through compile and parse with its effects intact', () => {
  const base = [{ start: 0, end: 10 }];
  const edit = {
    id: 'a', type: 'overlay', from: 2, to: 5, src: 'logo.png', x: 0.1, y: 0.2, w: 0.3,
    in: 'slide', out: 'fade', motion: 'float',
  };
  const { edits } = parseRecipe(compileSegments(base, [edit]));
  const o = edits.find((e) => e.type === 'overlay');
  for (const k of ['from', 'to', 'src', 'x', 'y', 'w', 'in', 'out', 'motion']) {
    assert.equal(o[k], edit[k], `${k} survived the round trip`);
  }
});

test('nearestEdge measures in pixels, not fractions', () => {
  // A 9:16 frame: x=0.9 is 0.1*0.5625 = 0.056 frame-heights from the right,
  // while y=0.1 is 0.1 from the top. The right edge is genuinely nearer.
  assert.equal(nearestEdge(0.9, 0.1, 9 / 16), 'right');
  assert.equal(nearestEdge(0.5, 0.02, 9 / 16), 'top');
  assert.equal(nearestEdge(0.02, 0.5, 9 / 16), 'left');
  assert.equal(nearestEdge(0.5, 0.98, 9 / 16), 'bottom');
});

test('a fade preview ramps in and out and is solid in the middle', () => {
  const e = { from: 2, to: 5, x: 0.1, y: 0.1, w: 0.2, in: 'fade', out: 'fade' };
  assert.equal(overlayPreviewStyle(e, 0).opacity, 0);
  assert.ok(Math.abs(overlayPreviewStyle(e, 0.175).opacity - 0.5) < 0.01);
  assert.equal(overlayPreviewStyle(e, 1.5).opacity, 1);
  assert.equal(overlayPreviewStyle(e, 3).opacity, 0);
});

test('a slide preview leaves the frame exactly and comes back to rest', () => {
  const e = { from: 0, to: 3, x: 0.5, y: 0.02, w: 0.2, in: 'slide' };
  const out = overlayPreviewStyle(e, 0, 9 / 16);        // fully out, off the top
  assert.equal(out.top, 0);
  assert.equal(out.transform, 'translate(0%, -100%)');
  const seated = overlayPreviewStyle(e, 1, 9 / 16);
  assert.equal(seated.top, 0.02);
  assert.equal(seated.transform, 'translate(0%, 0%)');
});

test('a right-edge slide needs no box-sized nudge', () => {
  const e = { from: 0, to: 3, x: 0.9, y: 0.5, w: 0.1, in: 'slide' };
  const out = overlayPreviewStyle(e, 0, 9 / 16);
  assert.ok(Math.abs(out.left - 1) < 1e-9);   // the box's LEFT edge is the frame's right
  assert.equal(out.transform, 'translate(0%, 0%)');
});

test('motion moves the box without moving its anchor', () => {
  const e = { from: 0, to: 3, x: 0.3, y: 0.4, w: 0.2, motion: 'bounce' };
  const rest = overlayPreviewStyle(e, 0);
  assert.equal(rest.transform, 'translate(0%, 0%)');
  const up = overlayPreviewStyle(e, 1 / (4 * 1.4));     // |sin| = 1
  assert.equal(up.left, 0.3);
  assert.equal(up.top, 0.4);
  assert.equal(up.transform, 'translate(0%, -12%)');
});

test('a plain overlay previews as a plain box', () => {
  const e = { from: 0, to: 3, x: 0.3, y: 0.4, w: 0.2 };
  assert.deepEqual(overlayPreviewStyle(e, 1.5),
    { opacity: 1, left: 0.3, top: 0.4, transform: 'translate(0%, 0%)' });
});

test('a short overlay shortens its own transition, like the renderer', () => {
  const e = { from: 0, to: 0.6, x: 0.1, y: 0.1, w: 0.2, in: 'fade' };
  assert.equal(overlayPreviewStyle(e, 0.2).opacity, 1);   // span is 0.2, not 0.35
});
