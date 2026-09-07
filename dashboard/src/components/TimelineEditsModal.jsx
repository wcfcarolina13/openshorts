import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Pause, Gauge, ImagePlus, Trash2, Loader2, AlertCircle, Layers, Maximize2, Smile, Clapperboard } from 'lucide-react';
import Modal from './ui/Modal';
import EmojiPicker from './EmojiPicker';
import GifPicker from './GifPicker';
import { readGiphyKey } from '../lib/giphyKey';
import { emojiToPng, emojiFileName } from '../lib/emojiRaster';
import { getApiUrl } from '../config';
import { apiFetch, apiJson } from '../lib/api';
import {
    compileSegments, parseRecipe, sourceToRendered, renderedToSource, totalDuration,
    SPEED_MIN, SPEED_MAX, MAX_TOTAL_SECONDS,
} from '../lib/timelineEdits';

// "Super easy" timeline edits: pick a moment on the clip, then pause there,
// slow the next bit down, or splice in an image / part of another video.
// Edits are human objects (see lib/timelineEdits.js); apply compiles them
// into the clip's recipe and re-renders through POST /api/clip/rerender,
// the same endpoint the trim editor uses, so the two never fight.

const SPEED_CHOICES = [0.5, 0.75, 1.5, 2];
// Whole-clip presets. The slider between them is the granular control; these
// are just the rates people ask for by name.
const CLIP_SPEED_CHOICES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SPEED_STEP = 0.05;
// Inline overlays: box as fractions of the frame. Snap to the edges, the
// centre lines and the rule-of-thirds so a logo lands somewhere deliberate.
const OVERLAY_W_MIN = 0.05;
const OVERLAY_W_MAX = 1;
const OVERLAY_DEFAULT = { x: 0.06, y: 0.72, w: 0.28 };
// An emoji reads at a glance, so it wants a smaller box than a logo does.
const EMOJI_DEFAULT = { x: 0.7, y: 0.08, w: 0.18 };
const SNAP = 0.02;
const snapTo = (value, targets) => {
    const hit = targets.find((t) => Math.abs(value - t) < SNAP);
    return hit === undefined ? value : hit;
};
const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.mp4,.mov';
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const VIDEO_EXT = /\.(mp4|mov)$/i;

function fmt(t) {
    if (!Number.isFinite(t)) return '–:––';
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

const round3 = (x) => Math.round(x * 1000) / 1000;
let seq = 0;
const newId = () => `ui${Date.now().toString(36)}${(seq += 1)}`;

const BIG_BTN = 'flex items-center gap-3 w-full px-4 py-3 rounded-input border border-rule hover:bg-paper3 hover:border-brass text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const CHIP_BTN = 'px-2 py-0.5 rounded-input border border-rule text-[11px] hover:bg-paper3';
const CHIP_BTN_ON = 'px-2 py-0.5 rounded-input border border-brass bg-paper3 text-[11px] text-brass';

export default function TimelineEditsModal({ isOpen, onClose, jobId, clipIndex, clipTitle, videoUrl, onRerendered }) {
    const [edl, setEdl] = useState(null);
    const [videoAspect, setVideoAspect] = useState(9 / 16);
    // One rate for the whole clip. A section slow multiplies with it.
    const [globalSpeed, setGlobalSpeed] = useState(1);
    const [loadError, setLoadError] = useState(null);
    const [base, setBase] = useState([]);
    const [edits, setEdits] = useState([]);
    const [renderedSegments, setRenderedSegments] = useState([]);
    const [assets, setAssets] = useState([]);
    const [playhead, setPlayhead] = useState(0);
    const [uploading, setUploading] = useState(false);
    // Which uploaded file the next insert uses, and whether it fills the
    // frame (its own stretch of timeline) or sits inline over the footage.
    const [insertMode, setInsertMode] = useState('fill');
    // Which media picker is open under the insert buttons: null | 'emoji' | 'gif'.
    const [picker, setPicker] = useState(null);
    const [draggingId, setDraggingId] = useState(null);
    const [rendering, setRendering] = useState(false);
    const [renderSeconds, setRenderSeconds] = useState(0);
    const [error, setError] = useState(null);
    const [previewUrl, setPreviewUrl] = useState(videoUrl);
    // Live simulation of edits that are not rendered yet: {edit} while an
    // overlay (pause badge / image / clip placeholder) is showing.
    const [simOverlay, setSimOverlay] = useState(null);
    const videoRef = useRef(null);
    // `loop` is a setInterval handle: rAF would freeze in a background tab.
    const simRef = useRef({ lastSrc: null, fired: new Set(), timer: null, loop: null });
    const fileRef = useRef(null);
    const barRef = useRef(null);

    // ---- load the clip's recipe + assets ---------------------------------
    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        setLoadError(null);
        setError(null);
        setPreviewUrl(videoUrl);
        (async () => {
            try {
                const data = await apiJson(`/api/clip/${jobId}/${clipIndex}/edl`);
                if (cancelled) return;
                const parsed = parseRecipe(data.segments || []);
                setEdl(data);
                setBase(parsed.base);
                setEdits(parsed.edits);
                setGlobalSpeed(parsed.globalSpeed);
                setRenderedSegments(data.segments || []);
                // The server's current file is the truth: caption/hook restyles
                // done on the card update the card, not App-level results, so
                // the videoUrl prop can lag behind by several renders.
                if (data.current_file) {
                    setPreviewUrl(`${getApiUrl(`/videos/${jobId}/${data.current_file}`)}?t=${Date.now()}`);
                }
                setPlayhead(parsed.base[0]?.start ?? 0);
                try {
                    const list = await apiJson(`/api/jobs/${jobId}/assets`);
                    if (!cancelled) setAssets(list.assets || []);
                } catch { /* assets are optional */ }
            } catch (e) {
                if (!cancelled) setLoadError(e.message || 'could not load the clip');
            }
        })();
        return () => { cancelled = true; };
    }, [isOpen, jobId, clipIndex, videoUrl]);

    useEffect(() => {
        if (!rendering) return undefined;
        setRenderSeconds(0);
        const t = setInterval(() => setRenderSeconds((s) => s + 1), 1000);
        return () => clearInterval(t);
    }, [rendering]);

    // ---- derived ----------------------------------------------------------
    const span = useMemo(() => ({
        start: base.length ? Math.min(...base.map((b) => b.start)) : 0,
        end: base.length ? Math.max(...base.map((b) => b.end)) : 1,
    }), [base]);
    const words = useMemo(() => (edl?.words || []).filter(
        (w) => base.some((b) => w.e > b.start && w.s < b.end)), [edl, base]);
    const compiled = useMemo(() => compileSegments(base, edits, globalSpeed), [base, edits, globalSpeed]);
    const limits = edl?.limits || {};
    const holdRange = limits.hold_ms || [40, 3000];
    const imageRange = limits.image_ms || [200, 10000];
    const sortedEdits = useMemo(() => edits.slice().sort(
        (a, b) => (a.type === 'slow' ? a.from : a.at) - (b.type === 'slow' ? b.from : b.at)), [edits]);
    const wordAtPlayhead = useMemo(() => {
        const w = words.filter((x) => x.e <= playhead + 0.01).pop();
        return w ? w.w : null;
    }, [words, playhead]);
    const dirty = useMemo(
        () => JSON.stringify(compiled) !== JSON.stringify(renderedSegments), [compiled, renderedSegments]);
    // Edits the rendered file does not contain yet — these get simulated
    // during playback (approximately) so you see them before applying.
    const pendingEdits = useMemo(() => {
        const rendered = parseRecipe(renderedSegments).edits;
        const same = (a, b) => a.type === b.type
            && Math.abs((a.type === 'slow' ? a.from : a.at) - (b.type === 'slow' ? b.from : b.at)) < 0.002
            && (a.type !== 'slow' || (Math.abs(a.to - b.to) < 0.002 && a.factor === b.factor))
            && (a.type !== 'pause' || a.ms === b.ms)
            && (a.type !== 'insert' || (a.src === b.src && a.kind === b.kind));
        return edits.filter((e) => !rendered.some((r) => same(e, r)));
    }, [edits, renderedSegments]);
    const renderedGlobalSpeed = useMemo(
        () => parseRecipe(renderedSegments).globalSpeed, [renderedSegments]);

    // ---- playback simulation ---------------------------------------------
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return undefined;
        const sim = simRef.current;
        const clearTimer = () => { if (sim.timer) { clearTimeout(sim.timer); sim.timer = null; } };
        const stopLoop = () => { if (sim.loop) { clearInterval(sim.loop); sim.loop = null; } };
        const tick = () => {
            if (v.paused || v.ended) { stopLoop(); return; }
            const src = renderedToSource(v.currentTime, renderedSegments);
            // slow ranges: change the playback rate while inside one
            const slow = pendingEdits.find((e) => e.type === 'slow' && src >= e.from && src < e.to);
            // The rendered file may already carry the global speed; only the
            // part that is not rendered yet needs simulating.
            const pendingGlobal = globalSpeed / (renderedGlobalSpeed || 1);
            const rate = Math.min(SPEED_MAX, Math.max(SPEED_MIN,
                (slow ? slow.factor : 1) * pendingGlobal));
            if (v.playbackRate !== rate) v.playbackRate = rate;
            // pauses / inserts: fire once when the playhead crosses the anchor
            const prev = sim.lastSrc;
            sim.lastSrc = src;
            if (prev !== null && src > prev) {
                const hit = pendingEdits.find((e) => e.type !== 'slow' && e.at > prev && e.at <= src && !sim.fired.has(e.id));
                if (hit) {
                    sim.fired.add(hit.id);
                    v.pause();
                    setSimOverlay(hit);
                    const ms = hit.type === 'pause' ? hit.ms : hit.kind === 'image' ? hit.ms : Math.round((hit.end - hit.start) * 1000);
                    sim.timer = setTimeout(() => {
                        setSimOverlay(null);
                        sim.timer = null;
                        v.play().catch(() => {});
                    }, ms);
                    stopLoop();
                    return;
                }
            }
            setPlayhead(src);
        };
        const onPlay = () => {
            if (sim.loop) return;
            sim.lastSrc = renderedToSource(v.currentTime, renderedSegments);
            sim.loop = setInterval(tick, 40);
        };
        // timeupdate is the safety net: if this effect re-attached while the
        // video was already playing (no new 'play' event), the loop restarts.
        const onTimeUpdate = () => { if (!sim.loop && !v.paused && !v.ended) onPlay(); };
        const onSeeked = () => {
            sim.fired.clear();
            sim.lastSrc = renderedToSource(v.currentTime, renderedSegments);
            // Scrubbing the player is the natural way to pick a moment, so it
            // moves the source playhead too (the bar and word chips still work).
            if (v.paused) setPlayhead(round3(sim.lastSrc));
        };
        const onEnded = () => { sim.fired.clear(); v.playbackRate = 1; };
        v.addEventListener('play', onPlay);
        v.addEventListener('playing', onPlay);
        v.addEventListener('timeupdate', onTimeUpdate);
        v.addEventListener('seeked', onSeeked);
        v.addEventListener('ended', onEnded);
        if (!v.paused && !v.ended) onPlay();
        return () => {
            v.removeEventListener('play', onPlay);
            v.removeEventListener('playing', onPlay);
            v.removeEventListener('timeupdate', onTimeUpdate);
            v.removeEventListener('seeked', onSeeked);
            v.removeEventListener('ended', onEnded);
            stopLoop();
            clearTimer();
            v.playbackRate = 1;
        };
    }, [pendingEdits, renderedSegments, edl, globalSpeed, renderedGlobalSpeed]);

    // ---- playhead / seeking ----------------------------------------------
    const seekTo = useCallback((t) => {
        const clamped = round3(Math.min(span.end, Math.max(span.start, t)));
        setPlayhead(clamped);
        const v = videoRef.current;
        if (v && Number.isFinite(v.duration)) {
            v.pause();
            v.currentTime = Math.min(v.duration, sourceToRendered(clamped, renderedSegments));
        }
    }, [span, renderedSegments]);

    const onBarClick = (e) => {
        const rect = barRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        seekTo(span.start + frac * (span.end - span.start));
    };
    const pct = (t) => `${((t - span.start) / (span.end - span.start || 1)) * 100}%`;
    // An unapplied insert whose anchor is where the playhead stands: show it
    // right away, so "insert media" gives feedback without pressing play.
    const standingOn = useMemo(() => pendingEdits.find(
        (e) => e.type === 'insert' && Math.abs(e.at - playhead) < 0.05) || null, [pendingEdits, playhead]);
    const overlay = simOverlay || standingOn;

    // ---- edit actions -----------------------------------------------------
    const addPause = () => setEdits((prev) => [...prev, { id: newId(), type: 'pause', at: playhead, ms: 100 }]);

    const addSlow = () => {
        const containing = edits.find((e) => e.type === 'slow' && playhead >= e.from && playhead < e.to);
        const from = containing ? containing.to : playhead;
        const nextSlow = edits.filter((e) => e.type === 'slow' && e.from > from).sort((a, b) => a.from - b.from)[0];
        const to = round3(Math.min(span.end, from + 2, nextSlow ? nextSlow.from : Infinity));
        if (to - from < 0.5) return;
        setEdits((prev) => [...prev, { id: newId(), type: 'slow', from, to, factor: 0.5 }]);
    };

    const addInsertFor = (name, mode = insertMode, box = OVERLAY_DEFAULT) => {
        // Anything we accept can ride over the footage: a still is held for
        // the window, a GIF or a video loops through it. Overlay audio is
        // dropped by the renderer so the speaker underneath stays audible.
        if (mode === 'inline') {
            const from = playhead;
            const to = round3(Math.min(span.end, from + 2));
            if (to - from < 0.5) {
                setError('not enough clip left here for an inline overlay — move the playhead earlier.');
                return;
            }
            setEdits((prev) => [...prev, {
                id: newId(), type: 'overlay', from, to, src: name, ...box,
            }]);
            return;
        }
        const insert = IMAGE_EXT.test(name)
            ? { id: newId(), type: 'insert', at: playhead, kind: 'image', src: name, ms: 1200, zoom: false }
            : { id: newId(), type: 'insert', at: playhead, kind: 'clip', src: name, start: 0, end: 2 };
        setEdits((prev) => [...prev, insert]);
    };

    // fill <-> inline on an edit that already exists, keeping its file.
    const setEditMode = (edit, mode) => {
        if (mode === 'inline' && edit.type === 'insert') {
            const from = edit.at;
            const to = round3(Math.min(span.end, from + 2));
            if (to - from < 0.5) { setError('not enough clip left here to go inline.'); return; }
            setEdits((prev) => prev.map((e) => (e.id === edit.id
                ? { id: e.id, type: 'overlay', from, to, src: e.src, ...OVERLAY_DEFAULT } : e)));
        } else if (mode === 'fill' && edit.type === 'overlay') {
            setEdits((prev) => prev.map((e) => (e.id === edit.id ? (VIDEO_EXT.test(e.src)
                ? { id: e.id, type: 'insert', at: e.from, kind: 'clip', src: e.src, start: 0, end: round3(Math.max(0.5, e.to - e.from)) }
                : { id: e.id, type: 'insert', at: e.from, kind: 'image', src: e.src, ms: 1200, zoom: false }) : e)));
        }
    };

    // Every media route ends here: store the bytes under the job, remember the
    // asset, and hand back what the server called it.
    const uploadAsset = async (body, name, contentType) => {
        const res = await apiFetch(`/api/jobs/${jobId}/assets/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': contentType || 'application/octet-stream' },
            body,
        });
        if (!res.ok) {
            let detail = `upload failed (HTTP ${res.status})`;
            try { detail = (await res.json()).detail || detail; } catch { /* keep */ }
            throw new Error(detail);
        }
        const saved = await res.json();
        setAssets((prev) => [...prev.filter((a) => a.name !== saved.name), saved]);
        return saved;
    };

    // One busy flag for all three: they all end in an upload and a placement.
    const withUpload = async (what, run) => {
        setUploading(true);
        setError(null);
        try {
            await run();
        } catch (err) {
            setError(err.message || `could not add that ${what}`);
        } finally {
            setUploading(false);
        }
    };

    const onPickFile = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        await withUpload('file', async () => {
            const name = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
            const saved = await uploadAsset(file, name, file.type);
            addInsertFor(saved.name);
        });
    };

    // The emoji is drawn by THIS browser's emoji font and uploaded as a
    // transparent PNG, so what is in the grid is what lands in the clip.
    const addEmoji = (char) => withUpload('emoji', async () => {
        const png = await emojiToPng(char);
        const saved = await uploadAsset(png, emojiFileName(char), 'image/png');
        addInsertFor(saved.name, 'inline', EMOJI_DEFAULT);
        setPicker(null);
    });

    // The server does the download, and it takes GIPHY's id — never a URL.
    const addGif = (gif) => withUpload('gif', async () => {
        const key = readGiphyKey();
        const res = await apiFetch(`/api/jobs/${jobId}/gifs/${encodeURIComponent(gif.id)}`, {
            method: 'POST', headers: key ? { 'X-Giphy-Key': key } : {},
        });
        if (!res.ok) {
            let detail = `could not add that gif (HTTP ${res.status})`;
            try { detail = (await res.json()).detail || detail; } catch { /* keep */ }
            throw new Error(detail);
        }
        const saved = await res.json();
        setAssets((prev) => [...prev.filter((a) => a.name !== saved.name), saved]);
        addInsertFor(saved.name);
        setPicker(null);
    });

    const patchEdit = (id, patch) => setEdits((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));

    // Overlays the playhead is standing inside — those are the ones the
    // preview draws and lets you drag. A selected one shows regardless, so
    // placing it does not depend on parking the playhead first.
    const visibleOverlays = useMemo(() => edits.filter(
        (e) => e.type === 'overlay'
            && ((playhead >= e.from && playhead <= e.to) || e.id === draggingId)),
    [edits, playhead, draggingId]);

    // Drag to move, or drag the corner handle to resize. Fractions of the
    // frame throughout, which is exactly what the recipe stores.
    const startDrag = (edit, mode) => (down) => {
        down.preventDefault();
        down.stopPropagation();
        const boxEl = down.currentTarget.closest('[data-frame]');
        if (!boxEl) return;
        const frame = boxEl.getBoundingClientRect();
        const pointer = { x: down.clientX, y: down.clientY };
        const origin = { x: edit.x, y: edit.y, w: edit.w };
        setDraggingId(edit.id);
        const onMove = (move) => {
            const dx = (move.clientX - pointer.x) / frame.width;
            const dy = (move.clientY - pointer.y) / frame.height;
            if (mode === 'resize') {
                const w = Math.min(OVERLAY_W_MAX, Math.max(OVERLAY_W_MIN, origin.w + dx));
                patchEdit(edit.id, { w: round3(snapTo(w, [0.25, 0.5, 0.75, 1])) });
                return;
            }
            const w = origin.w;
            const x = snapTo(Math.min(1, Math.max(0, origin.x + dx)), [0, (1 - w) / 2, 1 - w]);
            const y = snapTo(Math.min(1, Math.max(0, origin.y + dy)), [0, 0.5, 1 - w, 0.72]);
            patchEdit(edit.id, { x: round3(x), y: round3(y) });
        };
        const onUp = () => {
            setDraggingId(null);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    };
    const removeEdit = (id) => setEdits((prev) => prev.filter((e) => e.id !== id));

    // ---- apply ------------------------------------------------------------
    const apply = async () => {
        setRendering(true);
        setError(null);
        try {
            const res = await apiFetch('/api/clip/rerender', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: clipIndex,
                    segments: compiled,
                    snap_to_words: false,
                    reapply_captions: true,
                }),
            });
            if (!res.ok) {
                let detail = `re-render failed (HTTP ${res.status})`;
                try { detail = (await res.json()).detail || detail; } catch { /* keep */ }
                throw new Error(detail);
            }
            const data = await res.json();
            setRenderedSegments(data.recipe.segments);
            setPreviewUrl(`${getApiUrl(data.new_video_url)}?t=${Date.now()}`);
            onRerendered?.(clipIndex, data);
        } catch (e) {
            setError(e.message || 're-render failed');
        } finally {
            setRendering(false);
        }
    };

    if (!isOpen) return null;

    const added = round3(totalDuration(compiled) - totalDuration(base));
    const tooLong = totalDuration(compiled) > MAX_TOTAL_SECONDS;

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="xl" eyebrow="EDITOR · TIMELINE" title="timeline edits">
            {loadError ? (
                <div className="flex items-center gap-2 text-danger"><AlertCircle size={16} />{loadError}</div>
            ) : !edl ? (
                <div className="flex items-center gap-2 text-muted"><Loader2 size={16} className="animate-spin" />loading clip…</div>
            ) : (
                <div className="flex flex-col md:flex-row gap-6">
                    {/* Left: preview + timeline */}
                    <div className="flex-1 min-w-0 flex flex-col gap-3">
                        <div
                            data-frame
                            style={{ aspectRatio: String(videoAspect), width: `min(100%, calc(52vh * ${videoAspect}))` }}
                            className="relative bg-black rounded-card border border-rule overflow-hidden max-h-[52vh] mx-auto"
                        >
                            <video
                                ref={videoRef}
                                src={previewUrl}
                                className="w-full h-full object-contain"
                                controls
                                playsInline
                                onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) setVideoAspect(v.videoWidth / v.videoHeight); }}
                            />
                            {overlay && overlay.type === 'insert' && overlay.kind === 'image' && (
                                <img src={getApiUrl(`/videos/${jobId}/assets/${overlay.src}`)} alt="" className="absolute inset-0 w-full h-full object-contain bg-black pointer-events-none" />
                            )}
                            {overlay && overlay.type === 'insert' && overlay.kind === 'clip' && (
                                <div className="absolute inset-0 flex items-center justify-center bg-black/85 text-ink2 text-sm pointer-events-none">clip “{overlay.src}” {(overlay.end - overlay.start).toFixed(1)} s</div>
                            )}
                            {visibleOverlays.map((o) => (
                                <div
                                    key={o.id}
                                    onPointerDown={startDrag(o, 'move')}
                                    style={{
                                        left: `${o.x * 100}%`,
                                        top: `${o.y * 100}%`,
                                        width: `${o.w * 100}%`,
                                    }}
                                    className={`absolute touch-none cursor-move ${draggingId === o.id ? 'outline outline-1 outline-brass' : 'hover:outline hover:outline-1 hover:outline-brass/60'}`}
                                >
                                    {VIDEO_EXT.test(o.src) ? (
                                        <video
                                            src={getApiUrl(`/videos/${jobId}/assets/${o.src}`)}
                                            autoPlay
                                            muted
                                            loop
                                            playsInline
                                            className="w-full h-auto select-none pointer-events-none"
                                        />
                                    ) : (
                                        <img
                                            src={getApiUrl(`/videos/${jobId}/assets/${o.src}`)}
                                            alt=""
                                            draggable={false}
                                            className="w-full h-auto select-none pointer-events-none"
                                        />
                                    )}
                                    <span
                                        onPointerDown={startDrag(o, 'resize')}
                                        className="absolute -right-1 -bottom-1 w-3 h-3 rounded-sm bg-brass cursor-nwse-resize touch-none"
                                        title="drag to resize"
                                    />
                                </div>
                            ))}
                            {simOverlay && simOverlay.type === 'pause' && (
                                <div className="absolute top-3 left-1/2 -translate-x-1/2 px-2 py-1 rounded-input bg-black/70 text-brass text-[11px] pointer-events-none flex items-center gap-1"><Pause size={12} />{simOverlay.ms} ms</div>
                            )}
                        </div>
                        {pendingEdits.length > 0 && (
                            <p className="text-[11px] text-muted -mt-1">preview simulates {pendingEdits.length} unapplied edit{pendingEdits.length > 1 ? 's' : ''} during playback (approximate) — apply to render them for real.</p>
                        )}

                        <div>
                            <div className="flex justify-between items-baseline mb-1">
                                <span className="eyebrow">Source timeline · click to place</span>
                                <span className="readout">{fmt(span.start)} – {fmt(span.end)}</span>
                            </div>
                            <div
                                ref={barRef}
                                onClick={onBarClick}
                                className="relative h-8 rounded-input bg-paper3 border border-rule cursor-crosshair select-none"
                                title="click to move the playhead"
                            >
                                {sortedEdits.map((e) => (e.type === 'slow' ? (
                                    <div key={e.id} className="absolute top-0 bottom-0 bg-brass/25"
                                        style={{ left: pct(e.from), width: `calc(${pct(e.to)} - ${pct(e.from)})` }} />
                                ) : (
                                    <div key={e.id} className={`absolute top-0 bottom-0 w-[3px] ${e.type === 'pause' ? 'bg-ink2' : 'bg-brass'}`}
                                        style={{ left: pct(e.at) }} />
                                )))}
                                <div className="absolute -top-1 -bottom-1 w-[2px] bg-white" style={{ left: pct(playhead) }} />
                            </div>
                        </div>

                        <div>
                            <p className="eyebrow mb-1">Words · click one to pause after it</p>
                            <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                                {words.map((w, i) => {
                                    const active = w.e <= playhead + 0.01 && (!words[i + 1] || words[i + 1].e > playhead + 0.01);
                                    return (
                                        <button key={`${w.s}-${i}`} onClick={() => seekTo(w.e)}
                                            className={active ? CHIP_BTN_ON : CHIP_BTN}>
                                            {w.w}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    {/* Right: actions + chips */}
                    <div className="w-full md:w-[340px] shrink-0 flex flex-col gap-4">
                        <div>
                            {clipTitle && <p className="text-[12px] text-muted truncate mb-2" title={clipTitle}>{clipTitle}</p>}
                            <p className="eyebrow mb-1">At · scrub the player, click the bar, or click a word</p>
                            <p className="text-lg">
                                {fmt(playhead)}
                                {wordAtPlayhead && <span className="text-muted text-sm"> · after “{wordAtPlayhead}”</span>}
                            </p>
                        </div>

                        <div className="rounded-input border border-rule p-3">
                            <div className="flex items-baseline justify-between mb-2">
                                <p className="eyebrow">Whole clip speed</p>
                                <span className="readout text-brass">{globalSpeed.toFixed(2)}×</span>
                            </div>
                            <input
                                type="range"
                                className="w-full accent-brass"
                                min={SPEED_MIN}
                                max={SPEED_MAX}
                                step={SPEED_STEP}
                                value={globalSpeed}
                                disabled={rendering}
                                aria-label="whole clip speed"
                                onChange={(ev) => setGlobalSpeed(round3(Number(ev.target.value)))}
                            />
                            <div className="flex flex-wrap gap-1 mt-2">
                                {CLIP_SPEED_CHOICES.map((f) => (
                                    <button
                                        key={f}
                                        onClick={() => setGlobalSpeed(f)}
                                        disabled={rendering}
                                        className={Math.abs(globalSpeed - f) < 1e-6 ? CHIP_BTN_ON : CHIP_BTN}
                                    >
                                        {f === 1 ? 'normal' : `${f}×`}
                                    </button>
                                ))}
                            </div>
                            <p className="text-[11px] text-muted mt-2">
                                {globalSpeed === 1
                                    ? 'the clip plays at its recorded speed.'
                                    : `the whole clip runs at ${globalSpeed.toFixed(2)}× — ${fmt(totalDuration(compiled))} instead of ${fmt(totalDuration(base))}. Voices keep their pitch.`}
                            </p>
                        </div>

                        <div className="flex flex-col gap-2">
                            <button className={BIG_BTN} onClick={addPause} disabled={rendering}>
                                <Pause size={18} className="text-brass shrink-0" />
                                <span><span className="block text-sm">pause here</span><span className="block text-[11px] text-muted">freeze the frame for 100 ms (adjustable)</span></span>
                            </button>
                            <button className={BIG_BTN} onClick={addSlow} disabled={rendering}>
                                <Gauge size={18} className="text-brass shrink-0" />
                                <span><span className="block text-sm">slow down</span><span className="block text-[11px] text-muted">the next 2 s at half speed (adjustable)</span></span>
                            </button>
                            <div className="rounded-input border border-rule p-2 flex gap-1.5">
                                <button
                                    onClick={() => setInsertMode('fill')}
                                    className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-input text-[12px] ${insertMode === 'fill' ? 'border border-brass bg-paper3 text-brass' : 'border border-rule hover:bg-paper3'}`}
                                >
                                    <Maximize2 size={13} />fill the frame
                                </button>
                                <button
                                    onClick={() => setInsertMode('inline')}
                                    className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-input text-[12px] ${insertMode === 'inline' ? 'border border-brass bg-paper3 text-brass' : 'border border-rule hover:bg-paper3'}`}
                                >
                                    <Layers size={13} />inline
                                </button>
                            </div>
                            <button className={BIG_BTN} onClick={() => fileRef.current?.click()} disabled={rendering || uploading}>
                                {uploading ? <Loader2 size={18} className="animate-spin text-brass shrink-0" /> : <ImagePlus size={18} className="text-brass shrink-0" />}
                                <span>
                                    <span className="block text-sm">insert media</span>
                                    <span className="block text-[11px] text-muted">
                                        {insertMode === 'inline'
                                            ? 'an image, sticker or video over the footage — drag it where you want it'
                                            : 'an image or a piece of another video, taking the whole frame'}
                                    </span>
                                </span>
                            </button>
                            <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={onPickFile} />
                            <div className="flex gap-1.5">
                                <button
                                    onClick={() => setPicker(picker === 'emoji' ? null : 'emoji')}
                                    disabled={rendering || uploading}
                                    className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-input text-[12px] disabled:opacity-40 ${picker === 'emoji' ? 'border border-brass bg-paper3 text-brass' : 'border border-rule hover:bg-paper3'}`}
                                >
                                    <Smile size={13} />emoji
                                </button>
                                <button
                                    onClick={() => setPicker(picker === 'gif' ? null : 'gif')}
                                    disabled={rendering || uploading}
                                    className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-input text-[12px] disabled:opacity-40 ${picker === 'gif' ? 'border border-brass bg-paper3 text-brass' : 'border border-rule hover:bg-paper3'}`}
                                >
                                    <Clapperboard size={13} />gif
                                </button>
                            </div>
                            {picker === 'emoji' && <EmojiPicker onPick={addEmoji} busy={uploading} />}
                            {picker === 'gif' && <GifPicker onPick={addGif} busy={uploading} />}
                            {assets.length > 0 && (
                                <select className="input-field text-sm" value="" onChange={(e) => { if (e.target.value) addInsertFor(e.target.value); }}>
                                    <option value="">insert an uploaded file…</option>
                                    {assets.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
                                </select>
                            )}
                        </div>

                        <div className="flex-1 min-h-0">
                            <p className="eyebrow mb-1">Edits {sortedEdits.length ? `(${sortedEdits.length})` : ''}</p>
                            {sortedEdits.length === 0 && <p className="text-[12px] text-muted">none yet — place the playhead and pick an action.</p>}
                            <div className="flex flex-col gap-2 max-h-[30vh] overflow-y-auto pr-1">
                                {sortedEdits.map((e) => (
                                    <div key={e.id} className="rounded-input border border-rule p-2 text-[12px] flex flex-col gap-1.5">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="lowercase">
                                                {e.type === 'pause' && <>pause at {fmt(e.at)}</>}
                                                {e.type === 'slow' && <>slow {fmt(e.from)} → {fmt(e.to)}</>}
                                                {e.type === 'insert' && <>{e.kind} “{e.src}” at {fmt(e.at)}</>}
                                                {e.type === 'overlay' && <>inline “{e.src}” {fmt(e.from)} → {fmt(e.to)}</>}
                                            </span>
                                            <button onClick={() => removeEdit(e.id)} className="text-muted hover:text-danger" title="remove"><Trash2 size={14} /></button>
                                        </div>
                                        {e.type === 'pause' && (
                                            <label className="flex items-center gap-2">
                                                <input type="range" min={holdRange[0]} max={holdRange[1]} step="10" value={e.ms}
                                                    onChange={(ev) => patchEdit(e.id, { ms: parseInt(ev.target.value, 10) })}
                                                    className="flex-1 accent-[var(--color-accent)]" />
                                                <span className="readout w-16 text-right">{e.ms} ms</span>
                                            </label>
                                        )}
                                        {e.type === 'slow' && (
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="text-muted">to</span>
                                                <input type="number" step="0.1" min={e.from + 0.5} max={span.end} value={e.to}
                                                    onChange={(ev) => patchEdit(e.id, { to: round3(Math.min(span.end, Math.max(e.from + 0.5, parseFloat(ev.target.value) || e.to))) })}
                                                    className="input-field w-20 text-[12px] py-0.5" />
                                                <span className="text-muted">s ·</span>
                                                <input
                                                    type="range"
                                                    className="w-20 accent-brass"
                                                    min={SPEED_MIN}
                                                    max={SPEED_MAX}
                                                    step={SPEED_STEP}
                                                    value={e.factor}
                                                    aria-label="section speed"
                                                    onChange={(ev) => patchEdit(e.id, { factor: round3(Number(ev.target.value)) })}
                                                />
                                                <span className="readout">{e.factor.toFixed(2)}×</span>
                                                {SPEED_CHOICES.map((f) => (
                                                    <button key={f} onClick={() => patchEdit(e.id, { factor: f })}
                                                        className={e.factor === f ? CHIP_BTN_ON : CHIP_BTN}>{f}×</button>
                                                ))}
                                            </div>
                                        )}
                                        {e.type === 'insert' && e.kind === 'image' && (
                                            <div className="flex items-center gap-2">
                                                <input type="range" min={imageRange[0]} max={imageRange[1]} step="100" value={e.ms}
                                                    onChange={(ev) => patchEdit(e.id, { ms: parseInt(ev.target.value, 10) })}
                                                    className="flex-1 accent-[var(--color-accent)]" />
                                                <span className="readout w-14 text-right">{(e.ms / 1000).toFixed(1)} s</span>
                                                <button onClick={() => patchEdit(e.id, { zoom: !e.zoom })} className={e.zoom ? CHIP_BTN_ON : CHIP_BTN}>zoom</button>
                                                <button onClick={() => setEditMode(e, 'inline')} className={CHIP_BTN} title="show it over the footage instead">inline</button>
                                            </div>
                                        )}
                                        {e.type === 'overlay' && (
                                            <div className="flex flex-col gap-1.5">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="text-muted">until</span>
                                                    <input type="number" step="0.1" min={e.from + 0.5} max={span.end} value={e.to}
                                                        onChange={(ev) => patchEdit(e.id, { to: round3(Math.min(span.end, Math.max(e.from + 0.5, parseFloat(ev.target.value) || e.to))) })}
                                                        className="input-field w-20 text-[12px] py-0.5" />
                                                    <span className="text-muted">s</span>
                                                    <button onClick={() => setEditMode(e, 'fill')} className={CHIP_BTN} title="give it the whole frame instead">fill</button>
                                                </div>
                                                <label className="flex items-center gap-2">
                                                    <span className="text-muted">size</span>
                                                    <input type="range" min={OVERLAY_W_MIN} max={OVERLAY_W_MAX} step="0.01" value={e.w}
                                                        onChange={(ev) => patchEdit(e.id, { w: round3(Number(ev.target.value)) })}
                                                        className="flex-1 accent-brass" />
                                                    <span className="readout w-10 text-right">{Math.round(e.w * 100)}%</span>
                                                </label>
                                                <p className="text-[11px] text-muted">
                                                    {playhead >= e.from && playhead <= e.to
                                                        ? 'drag it on the preview; the corner handle resizes it.'
                                                        : 'move the playhead into its range to drag it on the preview.'}
                                                </p>
                                            </div>
                                        )}
                                        {e.type === 'insert' && e.kind === 'clip' && (
                                            <div className="flex items-center gap-2">
                                                <span className="text-muted">from</span>
                                                <input type="number" step="0.1" min="0" value={e.start}
                                                    onChange={(ev) => patchEdit(e.id, { start: round3(Math.max(0, parseFloat(ev.target.value) || 0)) })}
                                                    className="input-field w-16 text-[12px] py-0.5" />
                                                <span className="text-muted">to</span>
                                                <input type="number" step="0.1" min={e.start + 0.5} value={e.end}
                                                    onChange={(ev) => patchEdit(e.id, { end: round3(Math.max(e.start + 0.5, parseFloat(ev.target.value) || e.end)) })}
                                                    className="input-field w-16 text-[12px] py-0.5" />
                                                <span className="text-muted">s of the file</span>
                                                <button onClick={() => setEditMode(e, 'inline')} className={CHIP_BTN} title="show it over the footage instead">inline</button>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="mt-auto pt-3 border-t border-rule flex flex-col gap-2">
                            <div className="flex justify-between readout">
                                <span>{totalDuration(compiled).toFixed(1)} s total</span>
                                <span>{added >= 0 ? '+' : ''}{added.toFixed(1)} s</span>
                            </div>
                            {tooLong && (
                                <div className="flex items-start gap-2 text-danger text-[12px]">
                                    <AlertCircle size={14} className="shrink-0 mt-0.5" />
                                    {totalDuration(compiled).toFixed(1)} s is past the {MAX_TOTAL_SECONDS} s the renderer accepts — raise the speed or trim the clip.
                                </div>
                            )}
                            {error && <div className="flex items-start gap-2 text-danger text-[12px]"><AlertCircle size={14} className="shrink-0 mt-0.5" />{error}</div>}
                            <div className="flex gap-2">
                                <button onClick={onClose} className="btn-ghost">{dirty ? 'cancel' : 'close'}</button>
                                <button onClick={apply} disabled={rendering || !dirty || tooLong || compiled.length === 0} className="btn-primary flex-1">
                                    {rendering ? <span className="flex items-center justify-center gap-2"><Loader2 size={16} className="animate-spin" />rendering… {renderSeconds}s</span> : 'apply edits'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </Modal>
    );
}
