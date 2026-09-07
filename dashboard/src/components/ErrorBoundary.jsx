import React from 'react';

// Without this, one thrown render error unmounts the whole tree and the page
// goes black with the cause visible only in the console. Styles are inline on
// purpose: the boundary has to render even when the failure is in the styling
// or in a shared layout component.
const shell = {
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '24px', background: '#0b0b0d', color: '#e7e5e4',
    font: '14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif',
};
const panel = {
    maxWidth: '720px', width: '100%', border: '1px solid #3f3f46',
    borderRadius: '10px', padding: '20px', background: '#141417',
};
const pre = {
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '12px 0 0',
    maxHeight: '260px', overflow: 'auto', padding: '10px', borderRadius: '6px',
    background: '#09090b', color: '#a1a1aa', fontSize: '12px',
};
const button = {
    padding: '7px 14px', borderRadius: '6px', border: '1px solid #52525b',
    background: 'transparent', color: '#e7e5e4', cursor: 'pointer', fontSize: '13px',
};

const overlay = {
    position: 'fixed', inset: 0, zIndex: 100, display: 'flex',
    alignItems: 'center', justifyContent: 'center', padding: '24px',
    background: 'rgba(0,0,0,0.72)',
    font: '14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif',
    color: '#e7e5e4',
};

// `where` names the surface that failed, so a modal crash says which modal.
// `inline` marks a boundary around a modal: it takes the modal's place as a
// centred overlay (the card it is mounted in is often off-screen) and leaves
// the rest of the app mounted behind it.
export default class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null, stack: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        this.setState({ stack: info?.componentStack || null });
        // Keep the console copy: it has the full stack with source maps.
        console.error(`[openshorts] ${this.props.where || 'app'} crashed`, error, info);
    }

    retry() {
        this.setState({ error: null, stack: null });
        // A modal that threw on open would throw again on the next render, so
        // close it on the way out and let the user re-open it deliberately.
        this.props.onDismiss?.();
    }

    report() {
        const { error, stack } = this.state;
        const text = [
            `openshorts ${this.props.where || 'app'} crashed`,
            `url: ${window.location.href}`,
            `when: ${new Date().toISOString()}`,
            `error: ${error?.message || error}`,
            error?.stack || '',
            stack || '',
        ].join('\n');
        navigator.clipboard?.writeText(text).catch(() => { /* clipboard may be blocked */ });
    }

    render() {
        const { error, stack } = this.state;
        if (!error) return this.props.children;

        const where = this.props.where || 'the dashboard';
        const body = (
            <div style={this.props.inline ? { ...panel, maxWidth: 'none' } : panel}>
                <p style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>{where} hit an error</p>
                <p style={{ margin: '6px 0 0', color: '#a1a1aa' }}>
                    Your clips and renders are safe on disk — this is the interface, not your work.
                </p>
                <pre style={pre}>{String(error?.message || error)}{stack ? `\n${stack}` : ''}</pre>
                <div style={{ display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' }}>
                    <button style={button} onClick={() => this.retry()}>try again</button>
                    <button style={button} onClick={() => window.location.reload()}>reload the page</button>
                    <button style={button} onClick={() => this.report()}>copy the details</button>
                    {!this.props.inline && (
                        <button
                            style={button}
                            onClick={() => {
                                try { localStorage.clear(); } catch { /* private mode */ }
                                window.location.reload();
                            }}
                        >
                            clear saved state and reload
                        </button>
                    )}
                </div>
            </div>
        );

        return <div style={this.props.inline ? overlay : shell}>{body}</div>;
    }
}
