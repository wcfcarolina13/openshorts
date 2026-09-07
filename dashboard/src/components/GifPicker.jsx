import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Loader2, ExternalLink } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { readGiphyKey, writeGiphyKey, GIPHY_CONSOLE_URL } from '../lib/giphyKey';

// Search GIPHY and hand back the id of the one that was clicked. Discord's
// picker is Tenor, but Google stopped issuing Tenor keys in Jan 2026 and
// decommissioned the API that June; GIPHY is the surviving equivalent.
//
// The key lives in localStorage and travels in a header, never in the URL. The
// server holds the real request, so the key is not baked into the page for a
// self-hosted deployment that sets GIPHY_API_KEY instead.

export default function GifPicker({ onPick, busy }) {
    const [query, setQuery] = useState('');
    const [gifs, setGifs] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [needsKey, setNeedsKey] = useState(false);
    const [keyDraft, setKeyDraft] = useState('');
    const seq = useRef(0);

    const load = useCallback(async (q) => {
        const mine = (seq.current += 1);
        setLoading(true);
        setError(null);
        try {
            const key = readGiphyKey();
            const res = await apiFetch(
                `/api/gifs/search?q=${encodeURIComponent(q || '')}&limit=24`,
                { headers: key ? { 'X-Giphy-Key': key } : {} },
            );
            if (mine !== seq.current) return; // a newer search already won
            if (res.status === 503) {
                setNeedsKey(true);
                setGifs([]);
                return;
            }
            if (!res.ok) {
                let detail = `GIF search failed (HTTP ${res.status})`;
                try { detail = (await res.json()).detail || detail; } catch { /* keep */ }
                throw new Error(detail);
            }
            const body = await res.json();
            setNeedsKey(false);
            setGifs(body.gifs || []);
        } catch (err) {
            if (mine === seq.current) setError(err.message || 'GIF search failed');
        } finally {
            if (mine === seq.current) setLoading(false);
        }
    }, []);

    // Trending on open, then debounced as the user types.
    useEffect(() => {
        const t = setTimeout(() => load(query), query ? 350 : 0);
        return () => clearTimeout(t);
    }, [query, load]);

    const saveKey = () => {
        const trimmed = keyDraft.trim();
        if (!trimmed) return;
        writeGiphyKey(trimmed);
        setKeyDraft('');
        setNeedsKey(false);
        load(query);
    };

    return (
        <div className="rounded-input border border-rule p-2 flex flex-col gap-2">
            <div className="relative">
                <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
                <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="search gifs — applause, mind blown, shipping…"
                    className="input-field text-[12px] py-1 pl-7"
                />
            </div>

            {needsKey && (
                <div className="rounded-input border border-rule2 p-2 flex flex-col gap-1.5">
                    <p className="text-[11px] text-muted">
                        GIF search needs a free GIPHY key — paste it once and it stays in this
                        browser.{' '}
                        <a href={GIPHY_CONSOLE_URL} target="_blank" rel="noreferrer"
                            className="text-brass hover:underline inline-flex items-center gap-0.5">
                            get one <ExternalLink size={10} />
                        </a>
                    </p>
                    <div className="flex gap-1.5">
                        <input
                            value={keyDraft}
                            onChange={(e) => setKeyDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveKey(); }}
                            placeholder="GIPHY API key"
                            className="input-field text-[12px] py-1 font-mono flex-1"
                        />
                        <button type="button" onClick={saveKey} disabled={!keyDraft.trim()}
                            className="px-2 py-1 rounded-input border border-brass text-brass
                                text-[12px] disabled:opacity-40">
                            save
                        </button>
                    </div>
                </div>
            )}

            {error && <p className="text-[11px] text-warn px-1">{error}</p>}

            <div className="max-h-[26vh] overflow-y-auto pr-1">
                {loading && !gifs.length ? (
                    <p className="text-[11px] text-muted px-1 py-2 flex items-center gap-1.5">
                        <Loader2 size={12} className="animate-spin" /> searching…
                    </p>
                ) : gifs.length ? (
                    <div className="grid grid-cols-3 gap-1">
                        {gifs.map((g) => (
                            <button
                                key={g.id}
                                type="button"
                                disabled={busy}
                                onClick={() => onPick(g)}
                                title={g.title || 'gif'}
                                className="relative aspect-square rounded-input overflow-hidden
                                    bg-paper3 hover:outline hover:outline-1 hover:outline-brass
                                    disabled:opacity-40 disabled:cursor-wait"
                            >
                                <img src={g.url} alt={g.title || ''} loading="lazy"
                                    className="w-full h-full object-cover" />
                            </button>
                        ))}
                    </div>
                ) : !needsKey && !error ? (
                    <p className="text-[11px] text-muted px-1 py-2">
                        {query ? `nothing for “${query}”.` : 'no gifs came back.'}
                    </p>
                ) : null}
            </div>

            {/* GIPHY's terms require the mark wherever their content is browsed. */}
            <p className="eyebrow text-[9px] text-muted">powered by giphy</p>
        </div>
    );
}
