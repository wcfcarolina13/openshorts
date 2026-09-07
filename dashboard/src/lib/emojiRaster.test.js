import test from 'node:test';
import assert from 'node:assert/strict';
import { inkBounds, emojiFileName } from './emojiRaster.js';
import { searchEmoji, ALL_EMOJI, EMOJI_GROUPS } from './emoji.js';

// A w x h RGBA buffer with `pixels` ([x, y, alpha]) painted into it.
function rgba(w, h, pixels) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (const [x, y, a] of pixels) data[(y * w + x) * 4 + 3] = a;
    return data;
}

test('inkBounds finds the tight box around the ink', () => {
    const data = rgba(10, 10, [[3, 4, 255], [6, 7, 255]]);
    assert.deepEqual(inkBounds(data, 10, 10), { x: 3, y: 4, width: 4, height: 4 });
});

test('inkBounds returns null for an empty canvas', () => {
    assert.equal(inkBounds(rgba(4, 4, []), 4, 4), null);
});

test('inkBounds ignores antialiasing fringe', () => {
    // Alpha 4 is fringe, alpha 200 is ink: only the latter sets the box.
    const data = rgba(8, 8, [[0, 0, 4], [5, 5, 200]]);
    assert.deepEqual(inkBounds(data, 8, 8), { x: 5, y: 5, width: 1, height: 1 });
});

test('inkBounds handles ink touching every edge', () => {
    const data = rgba(3, 3, [[0, 0, 255], [2, 2, 255]]);
    assert.deepEqual(inkBounds(data, 3, 3), { x: 0, y: 0, width: 3, height: 3 });
});

test('emojiFileName is stable and safe as an asset name', () => {
    assert.equal(emojiFileName('🔥'), 'emoji-1f525.png');
    // A multi-codepoint emoji keeps every point, so variants stay distinct.
    assert.equal(emojiFileName('❤️'), 'emoji-2764-fe0f.png');
    for (const [char] of ALL_EMOJI) {
        assert.match(emojiFileName(char), /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/,
            `${char} must satisfy the server's asset-name rule`);
    }
});

test('searchEmoji matches keywords, not just the character', () => {
    assert.deepEqual(searchEmoji('lol').map(([c]) => c), ['😂', '🤣']);
    assert.ok(searchEmoji('cash').some(([c]) => c === '💰'));
});

test('searchEmoji requires every term', () => {
    assert.deepEqual(searchEmoji('money face').map(([c]) => c), ['🤑']);
    assert.deepEqual(searchEmoji('lol cash'), []);
});

test('an empty query means "show the groups", not "no results"', () => {
    assert.equal(searchEmoji(''), null);
    assert.equal(searchEmoji('   '), null);
});

test('the catalogue has no duplicate characters', () => {
    const chars = ALL_EMOJI.map(([c]) => c);
    assert.equal(new Set(chars).size, chars.length);
});

test('every group is non-empty and every entry has keywords', () => {
    for (const group of EMOJI_GROUPS) {
        assert.ok(group.emoji.length > 0, `${group.name} is empty`);
        for (const [char, words] of group.emoji) {
            assert.ok(char.length > 0 && words.trim().length > 0, `${char} needs keywords`);
        }
    }
});
