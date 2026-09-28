# terabot

Opens a TeraBox/1024tera share link, extracts the video metadata and download
links, and (optionally) downloads the full preview rendition.

```bash
node terabot.mjs                                  # the default share link
node terabot.mjs "https://www.1024tera.com/sharing/link?surl=..." 
node terabot.mjs --download                       # also fetch + remux the video
node terabot.mjs --json                           # dump metadata JSON to stdout
node terabot.mjs --cookies storageState.json      # logged-in session (original dlink)
node terabot.mjs --out /path/to/dir
```

Output (in `./output/` by default):

- `metadata.json` — share info, file list, video meta, all download links
- with `--download`: `<name>.preview480.ts` (stitched transport stream) and
  `<name>.preview480.mp4` (ffmpeg remux, `h264 854x480 + aac`)

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
incomplete params) — the official web UI only calls it after login.  To get the
original 720p file's `dlink`, run with `--cookies <storageState.json>` from a
logged-in TeraBox browser session.

## Files

- `terabot.mjs` — the bot
- `probe*.mjs` — reconnaissance scripts (page/network/API experiments)
- `output/` — runtime output (gitignored)
