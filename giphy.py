"""GIPHY search and import for the timeline editor's GIF picker.

Discord's picker is Tenor, which would have been the obvious choice — but
Google stopped issuing Tenor API keys on 2026-01-13 and decommissioned the
service on 2026-06-30, so there is no key to get. GIPHY is the surviving
self-serve GIF library and is the documented migration target.

Two rules shape this module:

- **The key never reaches the browser.** Search is proxied, and the key comes
  from ``GIPHY_API_KEY`` or a per-request override, the same way Gemini's does.
- **Imports take a GIPHY id, never a URL.** The media URL is whatever GIPHY
  hands back for that id, and it must live under ``giphy.com``. Accepting a URL
  from the client would be an SSRF hole aimed at the internal network.
"""

import os
from urllib.parse import urlparse

import httpx

API_ROOT = "https://api.giphy.com/v1/gifs"
MEDIA_HOST_SUFFIX = "giphy.com"
# 'g' is the strictest rating GIPHY offers. This tool makes business content.
RATING = "g"
TIMEOUT = 20.0
SEARCH_LIMIT_MAX = 50
# A reaction GIF that will be scaled into a corner does not need to be huge,
# and an unbounded download is a way to fill the disk.
GIF_MAX_BYTES = int(os.environ.get("GIF_MAX_BYTES", str(8 * 1024 * 1024)))

CONSOLE_URL = "https://developers.giphy.com/dashboard/"


class GiphyError(Exception):
    """Carries the HTTP status the caller should surface."""

    def __init__(self, detail, status=502):
        super().__init__(detail)
        self.detail = detail
        self.status = status


def api_key(override=None):
    """The key to use, or None. An override (a key typed into Settings) wins
    over the environment, matching how this repo already resolves Gemini."""
    key = (override or "").strip() or (os.environ.get("GIPHY_API_KEY") or "").strip()
    return key or None


def _require_key(override=None):
    key = api_key(override)
    if not key:
        raise GiphyError(
            "No GIPHY API key. Add one in Settings, or set GIPHY_API_KEY. "
            f"Keys are free at {CONSOLE_URL}",
            status=503)
    return key


async def _get_json(client, url, params):
    try:
        response = await client.get(url, params=params)
    except httpx.HTTPError as exc:
        raise GiphyError(f"Could not reach GIPHY: {exc}")
    if response.status_code == 401 or response.status_code == 403:
        raise GiphyError("GIPHY rejected the API key.", status=502)
    if response.status_code == 429:
        raise GiphyError("GIPHY rate limit reached; try again shortly.", status=429)
    if response.status_code >= 400:
        raise GiphyError(f"GIPHY returned {response.status_code}.")
    try:
        return response.json()
    except ValueError:
        raise GiphyError("GIPHY returned something that is not JSON.")


def _rendition(images, *names):
    """First rendition present among ``names``, as ``{url, width, height}``."""
    for name in names:
        item = (images or {}).get(name) or {}
        url = item.get("url")
        if url:
            def _int(key):
                try:
                    return int(item.get(key) or 0)
                except (TypeError, ValueError):
                    return 0
            return {"url": url, "width": _int("width"), "height": _int("height")}
    return None


def _card(entry):
    """One grid entry, or None when GIPHY sent something unusable."""
    gif_id = str((entry or {}).get("id") or "")
    if not gif_id or not gif_id.isalnum():
        return None
    preview = _rendition(entry.get("images"),
                         "fixed_width_small", "fixed_width", "downsized", "original")
    if not preview:
        return None
    return {"id": gif_id, "title": str(entry.get("title") or "").strip(), **preview}


async def search(query, limit=24, key_override=None, client=None):
    """Grid entries for ``query`` — GIPHY's trending list when it is empty."""
    key = _require_key(key_override)
    limit = max(1, min(SEARCH_LIMIT_MAX, int(limit or 24)))
    query = (query or "").strip()
    if query:
        url, params = f"{API_ROOT}/search", {"q": query, "lang": "en"}
    else:
        url, params = f"{API_ROOT}/trending", {}
    params.update({"api_key": key, "limit": limit, "rating": RATING})

    async def run(c):
        return await _get_json(c, url, params)

    payload = await (run(client) if client is not None else _with_client(run))
    cards = [_card(e) for e in (payload.get("data") or [])]
    return [c for c in cards if c]


async def _with_client(run):
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
        return await run(client)


def _media_url(entry):
    """The file to download for one GIPHY entry, checked for host."""
    chosen = _rendition(entry.get("images"), "downsized", "original", "fixed_width")
    if not chosen:
        raise GiphyError("GIPHY has no downloadable file for that GIF.", status=404)
    url = chosen["url"]
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not (
            host == MEDIA_HOST_SUFFIX or host.endswith("." + MEDIA_HOST_SUFFIX)):
        # GIPHY handed back a host we do not recognise. Refusing is the whole
        # reason this endpoint takes an id instead of a URL.
        raise GiphyError(f"Refusing a media URL outside {MEDIA_HOST_SUFFIX}: {host or url}")
    return url


async def fetch(gif_id, key_override=None, client=None):
    """Download one GIF by GIPHY id. Returns its bytes.

    The id is looked up first so the URL comes from GIPHY, never the caller.
    """
    key = _require_key(key_override)
    gif_id = str(gif_id or "")
    if not gif_id.isalnum() or len(gif_id) > 64:
        raise GiphyError("That is not a GIPHY id.", status=400)

    async def run(c):
        payload = await _get_json(c, f"{API_ROOT}/{gif_id}", {"api_key": key, "rating": RATING})
        entry = payload.get("data") or {}
        if not entry:
            raise GiphyError("GIPHY has no GIF with that id.", status=404)
        url = _media_url(entry)
        chunks, size = [], 0
        try:
            async with c.stream("GET", url) as response:
                if response.status_code >= 400:
                    raise GiphyError(f"GIPHY media returned {response.status_code}.")
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > GIF_MAX_BYTES:
                        raise GiphyError(
                            f"That GIF is over {GIF_MAX_BYTES // (1024 * 1024)} MB.",
                            status=413)
                    chunks.append(chunk)
        except httpx.HTTPError as exc:
            raise GiphyError(f"Could not download the GIF: {exc}")
        if not size:
            raise GiphyError("GIPHY sent an empty file.")
        return b"".join(chunks)

    return await (run(client) if client is not None else _with_client(run))


def asset_name(gif_id):
    """Stable file name, so re-picking the same GIF reuses the same asset."""
    return f"giphy-{gif_id}.gif"
