# Emoji and GIF pickers — design

**Problem.** Inline overlays can be any uploaded asset, but getting one there
means finding a file on disk first. The two things people actually reach for —
an emoji and a reaction GIF — have no path into the editor at all.

**Shape.** Two pickers in the timeline editor that each end in the same place:
a file in the job's assets folder plus an inline `overlay` edit pointing at it.
Nothing downstream of `assets/<name>` changes.

## Emoji

Rendered locally, never fetched. The browser draws the character to a canvas
with the platform emoji font, the transparent margins are trimmed, and the
result is `PUT` to the existing asset endpoint as `emoji-<codepoints>.png`.

- **Apple emoji on this Mac** (the answer to "which set"): what the user sees
  when they type it is what gets baked into the clip. No CDN, no licence
  question, no dependency.
- 512 px square before trimming, so a full-frame emoji still has pixels.
- **Trimming matters.** `overlay.w` is the box width, so a glyph with baked-in
  side margin would be placed wrong and sized wrong. Scan the alpha channel,
  crop to the ink, re-draw into a tight square.
- Default box for an emoji is `w = 0.18` — smaller than a logo's 0.28, because
  an emoji reads at a glance.
- The catalogue is a static list in `dashboard/src/lib/emoji.js`: about 180
  characters in 8 groups, each with a keyword string for the search box. A
  picker library would be a large dependency for a grid.

## GIFs — GIPHY, because Tenor is gone

Discord's picker is Tenor, and Tenor is the obvious answer — but it is shut.
Google stopped issuing new API keys on **13 January 2026** and terminated all
API agreements on **30 June 2026**, decommissioning existing integrations. A
Tenor integration cannot be built today at any price: there is no key to get.

GIPHY is the live equivalent, still self-serve and free, and is actively
courting the migration (their developer home leads with a Tenor migration
guide). Same shape, different host.

**Key resolution follows the Gemini pattern already in this repo:** the
`GIPHY_API_KEY` environment variable is the default, and a key entered in
Settings overrides it per request. With no key anywhere the picker says so and
links the console, rather than failing silently.

**Attribution is not optional.** GIPHY's terms require the mark to be visible
wherever their content is browsed, so the picker carries "POWERED BY GIPHY".

### Endpoints

| route | does |
|---|---|
| `GET /api/gifs/search?q=&limit=` | proxies GIPHY `search` (or `trending` when `q` is empty) |
| `POST /api/jobs/{job_id}/gifs/{gif_id}` | server-side download into the job's assets, returns `{name}` |

**The client never supplies a URL.** It supplies a GIPHY *id*; the server
re-queries GIPHY for that id, takes the media URL from the response, and
refuses anything whose host is not under `giphy.com`. A picker that accepted a
URL would be an SSRF hole pointed at the internal network.

Other bounds:
- `rating=g` — the strictest GIPHY offers. This is business content.
- The grid shows `images.fixed_width_small`; the download takes
  `images.downsized` (or `original` when there is no downsized variant).
- Download is capped at `GIF_MAX_BYTES` (8 MB) and written through a `.part`
  file, the same way asset uploads are.
- Saved as `giphy-<id>.gif`, so re-picking the same GIF reuses the file.

## Fill-mode GIFs animate now

`IMAGE_EXTENSIONS` already contained `.gif`, so a GIF inserted in *fill* mode
went down the still-image path — `-loop 1` over a single decoded frame — and
rendered as a frozen first frame. With GIFs now arriving through a picker this
becomes a bug people will actually hit.

A `.gif` in an `image` segment is fed `-ignore_loop 0` and bounded by the
segment's own `-t`, so it animates and repeats for however long the insert
lasts. `zoom` is ignored for GIFs (a Ken Burns push over an animation is not a
thing anyone wants) and the editor hides the chip.

## Not in scope

- GIPHY's sticker, clip and emoji endpoints. The GIF grid is the ask.
- Recording which GIFs were used, or a favourites list.
- Emoji skin-tone or variant pickers.
