import React, { useEffect, useState } from 'react';
import { History, Loader2, RotateCcw, AlertCircle } from 'lucide-react';
import Modal from './ui/Modal';
import { apiFetch, apiJson } from '../lib/api';
import { getApiUrl } from '../config';

// Every rendered version of a clip still on disk, newest first. "restore"
// makes one of them current again (nothing is deleted, so it is undoable);
// a restored timeline recut brings its edit list back with it.
export default function VersionsModal({ isOpen, onClose, jobId, clipIndex, onRestored }) {
    const [versions, setVersions] = useState(null);
    const [budget, setBudget] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(null);

    const load = async () => {
        try {
            const d = await apiJson(`/api/clip/${jobId}/${clipIndex}/versions`);
            setVersions(d.versions || []);
            setBudget({ keep: d.keep, bytes: d.bytes });
        } catch (e) {
            setError(e.message || 'could not load versions');
        }
    };

    useEffect(() => {
        if (!isOpen) return;
        setVersions(null);
        setError(null);
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, jobId, clipIndex]);

    if (!isOpen) return null;

    const restore = async (file) => {
        setBusy(file);
        setError(null);
        try {
            const res = await apiFetch('/api/clip/revert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: jobId, clip_index: clipIndex, file }),
            });
            if (!res.ok) {
                let detail = `restore failed (HTTP ${res.status})`;
                try { detail = (await res.json()).detail || detail; } catch { /* keep */ }
                throw new Error(detail);
            }
            const data = await res.json();
            onRestored?.(data);
            await load();
        } catch (e) {
            setError(e.message || 'restore failed');
        } finally {
            setBusy(null);
        }
    };

    const when = (ts) => new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="lg" eyebrow="EDITOR · HISTORY" title="version history">
            {error && <div className="flex items-center gap-2 text-danger text-sm mb-3"><AlertCircle size={14} />{error}</div>}
            {!versions ? (
                <div className="flex items-center gap-2 text-muted"><Loader2 size={16} className="animate-spin" />loading…</div>
            ) : versions.length === 0 ? (
                <p className="text-muted text-sm">no rendered versions found.</p>
            ) : (
                <div className="flex flex-col gap-2 max-h-[65vh] overflow-y-auto pr-1">
                    {versions.map((v) => (
                        <div key={v.file} className={`flex items-center gap-3 p-2 rounded-input border ${v.current ? 'border-brass bg-paper3' : 'border-rule'}`}>
                            <div className="w-12 h-16 bg-black rounded-input overflow-hidden shrink-0">
                                <img src={getApiUrl(v.poster_url || v.video_url)} alt="" loading="lazy" className="w-full h-full object-cover" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm text-ink lowercase">
                                    <span>{(v.kinds || []).join(' + ') || 'render'}</span>
                                    {v.current && <span className="ml-2 readout text-brass">current</span>}
                                </p>
                                <p className="text-[11px] text-muted">{when(v.modified)} · {((v.bytes || 0) / 1e6).toFixed(1)} MB</p>
                            </div>
                            {v.current ? (
                                <History size={16} className="text-brass shrink-0" />
                            ) : (
                                <button onClick={() => restore(v.file)} disabled={busy !== null} className="btn-quiet px-3 py-1.5 text-xs flex items-center gap-1.5 shrink-0">
                                    {busy === v.file ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                                    restore
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}
            <p className="text-[11px] text-muted mt-3">
                Restoring never deletes anything: the version you leave stays in this list.
                {budget?.keep ? ` The newest ${budget.keep} are kept, plus the current one and the original — older ones are cleared to save disk.` : ''}
                {budget?.bytes ? ` This clip's history is using ${(budget.bytes / 1e6).toFixed(0)} MB.` : ''}
            </p>
        </Modal>
    );
}
