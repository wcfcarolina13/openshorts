# OpenShorts CLI

Clip long videos into vertical 9:16 shorts from the terminal. Zero
dependencies; talks to the same API the dashboard, the MCP server and the
webhooks use.

```bash
pip install openshorts        # or: uvx openshorts / pipx run openshorts

export OPENSHORTS_API_KEY=osk_...   # from your account page at openshorts.app

openshorts process "https://youtube.com/watch?v=..." --wait
openshorts clips <job_id>
openshorts publish <job_id> 0 --platforms tiktok,youtube
openshorts quota
```

Self-hosted instance? Point it at your own machine and skip the key:

```bash
export OPENSHORTS_API_URL=http://localhost:8000
openshorts process "https://youtube.com/watch?v=..." --wait
```

For pipelines, prefer the webhook to `--wait`: pass `--webhook` and
`--webhook-secret` and OpenShorts POSTs once (HMAC-signed,
`X-OpenShorts-Signature: sha256=<hex>`) when the job ends, with clip titles
and durable download links.

The hosted free tier is 20 minutes/month with a watermark; paid plans from
$12/month. The self-hosted edition is MIT and has no meter. Agent-native
version of the same surface: [openshorts.app/mcp](https://www.openshorts.app/mcp).

## Timeline edits (`recut`)

Re-render one clip from a JSON edit list. Source ranges are `{start, end}` in
source seconds (optional `speed` 0.25–4); the other entries are edits:

| kind | fields | effect |
|---|---|---|
| `hold` | `at`, `ms` (40–3000) | freeze the frame at `at` for `ms`, silent |
| `image` | `src`, `ms` (200–10000), `zoom` | a still from the job's assets, letterboxed to the clip, optional Ken Burns |
| `clip` | `src`, `start`, `end` | a range of another uploaded video |

```bash
cat > edits.json <<'EOF'
{"segments": [
  {"start": 0, "end": 15.68},
  {"kind": "hold", "at": 15.68, "ms": 100},
  {"start": 15.68, "end": 19.1, "speed": 0.6},
  {"kind": "image", "src": "logo.png", "ms": 1200, "zoom": true},
  {"start": 19.1, "end": 20.957}
]}
EOF
openshorts recut <job_id> 0 --edl edits.json --asset ./logo.png
```

`--asset` uploads to `PUT /api/jobs/<job>/assets/<name>` first; captions are
re-timed and re-burned unless `--no-captions`. Edits are cut from the clip's
original rendered file, so source ranges must stay inside the clip's original
range.
