import React, { useEffect, useState } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import { apiJson } from '../lib/api';
import { getApiUrl } from '../config';

// Self-host only: finished jobs still on disk, so "new project" is not a
// one-way door. Cloud accounts have the History tab instead.
export default function RecentProjects({ onReopen, currentJobId }) {
    const [projects, setProjects] = useState(null);
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        apiJson('/api/local/projects')
            .then((d) => { if (!cancelled) setProjects((d.projects || []).filter((p) => p.job_id !== currentJobId)); })
            .catch(() => { if (!cancelled) setProjects([]); });
        return () => { cancelled = true; };
    }, [currentJobId]);

    if (!projects || projects.length === 0) return null;

    const reopen = async (jobId) => {
        setBusy(jobId);
        setError(null);
        try {
            await onReopen(jobId);
        } catch (e) {
            setError(e.message || 'could not reopen');
        } finally {
            setBusy(null);
        }
    };

    const when = (ts) => {
        if (!ts) return '';
        const d = new Date(ts * 1000);
        return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    };

    return (
        <div className="mt-8">
            <p className="eyebrow mb-2">Recent projects · kept on this machine until the retention sweep</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {projects.slice(0, 8).map((p) => (
                    <button
                        key={p.job_id}
                        onClick={() => reopen(p.job_id)}
                        disabled={busy !== null}
                        className="flex items-center gap-3 p-2 rounded-input border border-rule hover:bg-paper3 hover:border-brass text-left transition-colors disabled:opacity-50"
                    >
                        <div className="w-10 h-14 bg-black rounded-input overflow-hidden shrink-0">
                            {p.video_url && <video src={getApiUrl(p.video_url)} className="w-full h-full object-cover" muted playsInline preload="metadata" />}
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="text-sm text-ink truncate" title={p.title}>{p.title}</p>
                            <p className="text-[11px] text-muted">{p.clips} clip{p.clips === 1 ? '' : 's'} · {when(p.created)}</p>
                        </div>
                        {busy === p.job_id ? <Loader2 size={16} className="animate-spin text-brass shrink-0" /> : <FolderOpen size={16} className="text-muted shrink-0" />}
                    </button>
                ))}
            </div>
            {error && <p className="text-[12px] text-danger mt-2">{error}</p>}
        </div>
    );
}
