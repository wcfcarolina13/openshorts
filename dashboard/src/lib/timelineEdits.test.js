// node --test dashboard/src/lib/timelineEdits.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileSegments, parseRecipe, sourceToRendered, totalDuration, MIN_SEGMENT_SECONDS,
  SPEED_MIN, SPEED_MAX,
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
