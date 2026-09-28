# terabot

Opens a TeraBox/1024tera share link, extracts the video metadata and download
links, and (optionally) downloads the full preview rendition.

```bash
node login.mjs                                  # log in once -> cookies.json (gitignored)
node terabot.mjs                                  # the default share link
node terabot.mjs "https://www.1024tera.com/sharing/link?surl=..." 
node terabot.mjs --download                       # fetch + remux the 480p preview
node terabot.mjs --download-original --cookies cookies.json   # original file (slow, see below)
node terabot.mjs --json                           # dump metadata JSON to stdout
node terabot.mjs --cookies storageState.json      # logged-in session (original dlink)
node terabot.mjs --out /path/to/dir
node server.mjs --port 8788                       # REST API (see below)
```

Output (in `./output/` by default):

- `metadata.json` — share info, file list, video meta, all download links
- with `--download`: `<name>.preview480.ts` (stitched transport stream) and
  `<name>.preview480.mp4` (ffmpeg remux, `h264 854x480 + aac`)
- with `--download-original`: `<name>.mp4` (the original file, size + md5
  verified against the share metadata)

## What it captures

| Data | Endpoint | Notes |
|---|---|---|
| share info (shareid, uk, sign, sharer, expiry) | `GET /api/shorturlinfo` | fired on page load |
| file list (name, size, md5, thumbs, dims) | `GET /share/list` | paginated |
| video meta (duration, width/height, rotate, real_md5) | `GET /share/mediameta` | fired on load for videos |
| original-file direct link | `POST /share/download` | **login required** (see below) |
| preview HLS (480p transcode) | `GET /share/streaming` | works anonymously |

## How the preview download works

`/share/streaming?type=M3U8_FLV_264_480` returns an HLS playlist of ~3
segments (30 s) at a **random window** of the 480p transcode on every request.
The bot:

1. computes the stream signature client-side —
   `HMAC-SHA1hex("0dubox" + browserid + unixtime, "iuuPc64E4Fhn0rTXEzrnbLph0o5qyEEa")`
   (key recovered from the share bundle `shareLink.kax0xevo.js`),
2. refetches the playlist, unions the byte ranges until
   `[0, ts_size)` is fully covered (~15-30 fetches),
3. downloads each unique segment from the signed CDN URLs
   (`v4.freeterabox.com`, cookie-free, ~8 h validity),
4. stitches them, verifies 188-byte TS sync and remuxes with ffmpeg.

## Original-quality downloads

Anonymous `/share/download` returns `errno 2` (or `400310 need verify_v2` with
incomplete params) — the official web UI only calls it after login.

**Login**: `node login.mjs` opens `/login`, submits the credentials from
`.account.json` (gitignored, mode 600) and saves the session to
`cookies.json` (also gitignored).  No captcha appeared for this account.

**The request shape matters**: the Download button uses the `Wt` wrapper —
`POST /share/download?...&scene=purchased_list` with body
`product=share&nozip=0&fid_list=["<fs_id>"]&uk=<uk>&primaryid=<shareid>` —
and returns a signed `d.1024tera.com` dlink that **expires in ~10 minutes**.
The older `scene=""` shape (`os` wrapper) gets `errno 14` even when logged in.
Logged-in sessions also register the share first via
`/share/querysurltransfer`; the bot waits for that handshake before asking.

**Free-tier throttling**: the account is `userVipIdentity: 0` (free) and the
original-file CDN trickles **~10-27KB/s per connection** (parallel ranges
aggregate ~50-70KB/s).  `--download-original` therefore fetches parallel 2 MB
ranges through Playwright's cookie-sharing request context (the dlink needs
the session cookies; bare `fetch` gets 403), refreshes the dlink when within
2 min of expiry, reassembles, and verifies size + md5 (for videos the served
bytes hash to mediameta's `real_md5` — matching the CDN's `content-md5`
header — while `file.md5` is the file-record hash; either is accepted).
Budget ~10 min per 30 MB file.

## REST API

`node server.mjs` starts an HTTP server (default `127.0.0.1:8788`, no auth —
localhost only unless `--host` says otherwise):

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/health` | | `{ok, session, jobs}` |
| POST | `/api/info` | `{url?}` | **one synchronous call** — `200` with `download_url`, `stream_url`, `stream_segments`, `video` and full `metadata` (waits ~15-25 s in the queue) |
| POST | `/api/extract` | `{url?}` | `202 {id}` — metadata + links job (result carries the same envelope) |
| POST | `/api/download` | `{url?, mode: "preview"\|"original"}` | `202 {id}` |
| GET | `/api/jobs` | | job summaries, newest first |
| GET | `/api/jobs/:id` | | status, `progress`, `logs`, `result` (envelope + `files`) |
| DELETE | `/api/jobs/:id` | | cancel a queued job (`409` if running) |
| GET | `/api/metadata` | `?url=` | same envelope as `POST /api/info` (prefer the POST) |
| GET | `/api/files` | | list output files with sizes + URLs |
| GET | `/api/files/:name` | | download the file (traversal-guarded) |

The shared **envelope** (`/api/info`, `/api/metadata`, job `result`):

```jsonc
{
  "url": "https://www.1024tera.com/sharing/link?surl=...",
  "video": {"filename": "...", "duration": 141, "width": 1280, "height": 720,
            "size": 30187549, "md5": "e665...", "fid": "..."},
  "download_url": "https://d.1024tera.com/file/...?expires=...",  // original dlink, ~10 min TTL
  "download_available": true,
  "download_expires_at": "2026-09-28T17:00:00.000Z",
  "download_size": 30187549,
  "stream_url": "https://www.1024tera.com/share/streaming?...&sign=...",  // HLS window playlist
  "stream_bytes": 8758356,
  "stream_complete": true,
  "stream_segments": [{"range": "0-65535", "url": "https://v4.freeterabox.com/..."}],
  "metadata": { /* full terabot metadata */ }
}
```

Jobs run through a queue (default concurrency 1 — each launches a headless
Chromium); `progress` carries the latest phase (`harvest` / `dlink` /
`original` chunks with cumulative KB/s / `preview` segments), `logs` is a
capped ring of the bot's own output.

```bash
curl -s localhost:8788/health
# one call: metadata + download_url + stream_url (url in the JSON payload)
curl -s -X POST localhost:8788/api/info -H 'content-type: application/json' \
     -d '{"url":"https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg"}'
curl -s -X POST localhost:8788/api/extract -d '{}'        # -> {id}, async variant
curl -s localhost:8788/api/jobs/<id>                      # poll result
curl -s -X POST localhost:8788/api/download -d '{"mode":"preview"}'
curl -s -X POST localhost:8788/api/download -d '{"mode":"original"}'   # needs cookies.json
curl -O localhost:8788/api/files/Post%20493%20video%202.preview480.mp4
```

## Files

- `terabot.mjs` — the bot (CLI + exported `runTerabot(opts, hooks)` for the API)
- `server.mjs` — the REST API server
- `login.mjs` — one-shot login that persists `cookies.json`
- `probe*.mjs` — reconnaissance scripts (page/network/API experiments)
- `output/` — runtime output (gitignored)
- `.account.json` / `cookies.json` — credentials/session (gitignored, 600)
