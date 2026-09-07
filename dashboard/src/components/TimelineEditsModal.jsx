import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Pause, Gauge, ImagePlus, Trash2, Loader2, AlertCircle } from 'lucide-react';
import Modal from './ui/Modal';
import { getApiUrl } from '../config';
import { apiFetch, apiJson } from '../lib/api';
import {
    compileSegments, parseRecipe, sourceToRendered, renderedToSource, totalDuration,
} from '../lib/timelineEdits';

// "Super easy" timeline edits: pick a moment on the clip, then pause there,
// slow the next bit down, or splice in an image / part of another video.
// Edits are human objects (see lib/timelineEdits.js); apply compiles them
// into the clip's recipe and re-renders through POST /api/clip/rerender,
// the same endpoint the trim editor uses, so the two never fight.

const SPEED_CHOICES = [0.5, 0.75, 1.5, 2];
const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.mp4,.mov';
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

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
    const [loadError, setLoadError] = useState(null);
    const [base, setBase] = useState([]);
    const [edits, setEdits] = useState([]);
    const [renderedSegments, setRenderedSegments] = useState([]);
    const [assets, setAssets] = useState([]);
    const [playhead, setPlayhead] = useState(0);
    const [uploading, setUploading] = useState(false);
    const [rendering, setRendering] = useState(false);
    const [renderSeconds, setRenderSeconds] = useState(0);
    const [error, setError] = useState(null);
    const [previewUrl, setPreviewUrl] = useState(videoUrl);
    // Live simulation of edits that are not rendered yet: {edit} while an
    // overlay (pause badge / image / clip placeholder) is showing.
    const [simOverlay, setSimOverlay] = useState(null);
    const videoRef = useRef(null);
    const simRef = useRef({ lastSrc: null, fired: new Set(), timer: null, raf: null });
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
                setRenderedSegments(data.segments || []);
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
    const compiled = useMemo(() => compileSegments(base, edits), [base, edits]);
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

    // ---- playback simulation ---------------------------------------------
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return undefined;
        const sim = simRef.current;
        const clearTimer = () => { if (sim.timer) { clearTimeout(sim.timer); sim.timer = null; } };
        const tick = () => {
            if (v.paused || v.ended) { sim.raf = null; return; }
            const src = renderedToSource(v.currentTime, renderedSegments);
            // slow ranges: change the playback rate while inside one
            const slow = pendingEdits.find((e) => e.type === 'slow' && src >= e.from && src < e.to);
            const rate = slow ? slow.factor : 1;
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
                    sim.raf = null;
                    return;
                }
            }
            setPlayhead(src);
            sim.raf = requestAnimationFrame(tick);
        };
        const onPlay = () => { if (!sim.raf) { sim.lastSrc = renderedToSource(v.currentTime, renderedSegments); sim.raf = requestAnimationFrame(tick); } };
        const onSeeked = () => { sim.fired.clear(); sim.lastSrc = renderedToSource(v.currentTime, renderedSegments); };
        const onEnded = () => { sim.fired.clear(); v.playbackRate = 1; };
        v.addEventListener('play', onPlay);
        v.addEventListener('seeked', onSeeked);
        v.addEventListener('ended', onEnded);
        return () => {
            v.removeEventListener('play', onPlay);
            v.removeEventListener('seeked', onSeeked);
            v.removeEventListener('ended', onEnded);
            if (sim.raf) cancelAnimationFrame(sim.raf);
            sim.raf = null;
            clearTimer();
            v.playbackRate = 1;
        };
    }, [pendingEdits, renderedSegments, edl]);

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

    const addInsertFor = (name) => {
        const insert = IMAGE_EXT.test(name)
            ? { id: newId(), type: 'insert', at: playhead, kind: 'image', src: name, ms: 1200, zoom: false }
            : { id: newId(), type: 'insert', at: playhead, kind: 'clip', src: name, start: 0, end: 2 };
        setEdits((prev) => [...prev, insert]);
    };

    const onPickFile = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setUploading(true);
        setError(null);
        try {
            const name = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
            const res = await apiFetch(`/api/jobs/${jobId}/assets/${encodeURIComponent(name)}`, {
                method: 'PUT',
                headers: { 'Content-Type': file.type || 'application/octet-stream' },
                body: file,
            });
            if (!res.ok) {
                let detail = `upload failed (HTTP ${res.status})`;
                try { detail = (await res.json()).detail || detail; } catch { /* keep */ }
                throw new Error(detail);
            }
            const saved = await res.json();
            setAssets((prev) => [...prev.filter((a) => a.name !== saved.name), saved]);
            addInsertFor(saved.name);
        } catch (err) {
            setError(err.message || 'upload failed');
        } finally {
            setUploading(false);
        }
    };

    const patchEdit = (id, patch) => setEdits((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
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
                        <div className="relative bg-black rounded-card border border-rule overflow-hidden aspect-[9/16] max-h-[52vh] mx-auto w-full">
                            <video ref={videoRef} src={previewUrl} className="w-full h-full object-contain" controls playsInline />
                            {simOverlay && simOverlay.type === 'insert' && simOverlay.kind === 'image' && (
                                <img src={getApiUrl(`/videos/${jobId}/assets/${simOverlay.src}`)} alt="" className="absolute inset-0 w-full h-full object-contain bg-black pointer-events-none" />
                            )}
                            {simOverlay && simOverlay.type === 'insert' && simOverlay.kind === 'clip' && (
                                <div className="absolute inset-0 flex items-center justify-center bg-black/85 text-ink2 text-sm pointer-events-none">clip “{simOverlay.src}” {(simOverlay.end - simOverlay.start).toFixed(1)} s</div>
                            )}
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
                            <p className="eyebrow mb-1">At</p>
                            <p className="text-lg">
                                {fmt(playhead)}
                                {wordAtPlayhead && <span className="text-muted text-sm"> · after “{wordAtPlayhead}”</span>}
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
                            <button className={BIG_BTN} onClick={() => fileRef.current?.click()} disabled={rendering || uploading}>
                                {uploading ? <Loader2 size={18} className="animate-spin text-brass shrink-0" /> : <ImagePlus size={18} className="text-brass shrink-0" />}
                                <span><span className="block text-sm">insert media</span><span className="block text-[11px] text-muted">an image or a piece of another video, spliced in here</span></span>
                            </button>
                            <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={onPickFile} />
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
                            {error && <div className="flex items-start gap-2 text-danger text-[12px]"><AlertCircle size={14} className="shrink-0 mt-0.5" />{error}</div>}
                            <div className="flex gap-2">
                                <button onClick={onClose} className="btn-ghost">{dirty ? 'cancel' : 'close'}</button>
                                <button onClick={apply} disabled={rendering || !dirty || compiled.length === 0} className="btn-primary flex-1">
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
