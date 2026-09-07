// Turning an emoji character into a PNG the renderer can composite.
//
// The browser draws it with the platform's own emoji font, so what the user
// picked is exactly what lands in the clip — no CDN, no dependency, and no
// licensing question about redistributing someone's emoji art.

export const CANVAS_SIZE = 512;
// A glyph drawn at the full canvas size can overflow its box; 0.78 leaves room
// for the ones with tall ascenders, and the trim below reclaims the slack.
const FONT_RATIO = 0.78;
const FONT_STACK = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", '
    + '"Twemoji Mozilla", "EmojiOne Color", sans-serif';
// Below this alpha a pixel is antialiasing fringe, not ink.
const ALPHA_FLOOR = 8;

/**
 * Tight box around the non-transparent pixels of RGBA `data`, or null when the
 * canvas is empty (which is how a missing emoji font shows up).
 *
 * Pure so it can be tested without a canvas.
 */
export function inkBounds(data, width, height, alphaFloor = ALPHA_FLOOR) {
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (data[(y * width + x) * 4 + 3] > alphaFloor) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** `emoji-1f525.png` — stable, so picking the same emoji twice reuses the file. */
export function emojiFileName(char) {
    const points = [...String(char)]
        .map((c) => c.codePointAt(0).toString(16))
        .join('-');
    return `emoji-${points}.png`;
}

/**
 * Rasterise `char` to a transparent PNG Blob, cropped to the glyph itself.
 *
 * Cropping is not cosmetic: an overlay's `w` is the box width as a fraction of
 * the frame, so baked-in glyph margin would place and size the emoji wrong.
 */
export async function emojiToPng(char, size = CANVAS_SIZE) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('this browser cannot draw emoji to a canvas');
    ctx.clearRect(0, 0, size, size);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(size * FONT_RATIO)}px ${FONT_STACK}`;
    ctx.fillText(char, size / 2, size / 2);

    const { data } = ctx.getImageData(0, 0, size, size);
    const box = inkBounds(data, size, size);
    if (!box) throw new Error('this browser has no colour emoji font');

    // One pixel of margin keeps the antialiased edge off the crop line.
    const pad = 1;
    const out = document.createElement('canvas');
    out.width = box.width + pad * 2;
    out.height = box.height + pad * 2;
    out.getContext('2d').drawImage(
        canvas, box.x, box.y, box.width, box.height,
        pad, pad, box.width, box.height,
    );

    const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('could not encode the emoji as a PNG');
    return blob;
}
