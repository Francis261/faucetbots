# terabot REST API

HTTP interface for terabot: extract TeraBox/1024tera share metadata + download
links, trigger preview/original downloads, and fetch the resulting files.

- **Server:** `node terabot.mjs serve [--port 8788] [--host 127.0.0.1] [--out DIR] [--cookies FILE] [--concurrency N]`
  (`node terabot.mjs` with no args = same thing; `node server.mjs …` also works)
- **Base URL:** `http://127.0.0.1:8788` (default)
- **Format:** JSON in/out, UTF-8, CORS enabled (`*`)

> **Security:** the server binds localhost only and has **no authentication**.
> Do not pass `--host 0.0.0.0` (or otherwise expose it) unless you put your
> own auth in front of it.

---

## Quick start

```bash
node terabot.mjs login   # once: log in -> cookies.json (enables original quality)
                         #  (the server also auto-logins on boot when the
                         #   credentials file exists but no session does)
node terabot.mjs         # start the API

# ONE call: metadata + download_url + stream_url (url in the JSON payload)
curl -s -X POST http://127.0.0.1:8788/api/info \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.1024tera.com/sharing/link?surl=reCn7CaS8tLmcdVMe3SYWg"}'
```

Extract-style calls typically take **~3-8 s** — extraction runs on the
browser-free *fast path* (the share HTML is fetched with `curl --http2` for
its `jsToken`/`pcftoken`, then every API call is plain `fetch`; a Playwright
fallback engages only if that fails, or for `mode: "original"`). Downloads
take ~20-30 s (preview) or ~10 min (original, free accounts are throttled to
~50-70 KB/s).

---

## The envelope

`POST /api/info`, `GET /api/metadata`, and every job's `result` return the
same shape:

```jsonc
{
  "job_id": "fb80bdf5",
  "url": "https://www.1024tera.com/sharing/link?surl=...",

  "video": {
    "fid": "558462010993370",
    "filename": "Post 493 video 2.mp4",
    "duration": 141,                 // seconds
    "width": 1280, "height": 720,
    "size": 30187549,                // bytes (original file)
    "md5": "e665db4c5bccb9af0b37bcfd65462ca5"
  },

  // ---- original-quality file (needs logged-in cookies.json) ----
  "download_url": "https://d.1024tera.com/file/...?expires=...",
  "download_available": true,
  "download_errno": 0,               // non-zero when unavailable (e.g. 2 anonymous)
  "download_expires_at": "2026-09-28T17:21:35.000Z",   // dlink TTL ~10 min
  "download_size": 30187549,

  // ---- HLS preview stream (works anonymously) ----
  "stream_url": "https://www.1024tera.com/share/streaming?...&sign=...",
  "stream_type": "M3U8_FLV_264_480",
  "stream_bytes": 8758356,           // full 480p transcode size
  "stream_complete": true,           // segment list covers [0, stream_bytes)
  "stream_segments": [               // direct CDN links, cookie-free, ~8 h TTL
    { "range": "0-892623", "url": "https://v4.freeterabox.com/..." }
  ],
  "stream_note": "playlist serves random 30s windows; ...",

  "files": [],                       // files written by this job (paths)
  "metadata": {                      // full terabot metadata:
    "source": "...", "fetchedAt": "...", "session": "logged-in (...) | anonymous",
    "share":  { "shareid": 915161232457, "uk": 4399686012242,
                "sharer": "st***y", "permanent": true, "sign": "...", ... },
    "files":  [ { "fs_id": "...", "name": "...", "size": 30187549,
                  "md5": "...", "category": 1, ... } ],
    "videos": [ ... ],
    "downloads": {
      "original":   { "errno": 0, "available": true, "dlink": "...",
                      "file_info": { ... }, "downloaded": { ... } },
      "previewHLS": [ { "tsSize": 8758356, "covered": 8758356,
                        "segments": [ { "range": "...", "url": "..." } ], ... } ]
    },
    "files_written": [ ... ],
    "limitations": [ ... ]
  }
}
```

### Field notes

| Field | Meaning |
|---|---|
| `download_url` | The original file's signed dlink. Requires the logged-in session to fetch (bare requests get `403`), expires ~10 min after issue. Use `/api/download` to have the server fetch it. |
| `download_errno` | `0` ok · `2` / `400310` anonymous gate (need `cookies.json`) · `14` share not accepted · `-1` network error |
| `stream_url` | HLS playlist for **one random ~30 s window** of the 480p transcode. A player re-fetching it gets another random window; sign is timestamped, so treat it as short-lived. |
| `stream_segments` | The reliable stream/download primitive: all 15 byte-ranged CDN URLs covering the whole transcode, valid ~8 h, no cookies needed. |
| `stream_complete` | `true` when the segments cover `[0, stream_bytes)` exactly (usually **1 fetch** when logged in, up to ~40 anonymously). |
| `video.md5` | mediameta `real_md5` — the hash of the bytes the CDN actually serves (matches its `content-md5` header); `file.md5` in `metadata.files` is the file-record hash and may differ. |

---

## Endpoints

### `GET /`

Endpoint index (service name + short docs).

### `GET /health`

```json
{ "ok": true, "session": "logged-in cookies present", "out": ".../output",
  "jobs": { "total": 3, "active": 1, "queued": 0 } }
```

`session` tells you whether `cookies.json` exists (original downloads need it).

### `POST /api/info` — the one-call endpoint

Body: `{"url": "https://..."}` (`url` optional → default share link).

Runs a full extraction synchronously through the queue and responds `200`
with the envelope above. Waits **~3-8 s** (fast path; plus any queued jobs
ahead of it).

```bash
curl -s -X POST http://127.0.0.1:8788/api/info \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.1024tera.com/sharing/link?surl=..."}'
```

### `POST /api/urls` — only the two links

Same body (and same queue/fast-path extraction as `/api/info`), but the
response is **just** the two URLs — no metadata payload:

```json
{
  "download_url": "https://d.1024tera.com/file/...?sign=...",
  "stream_url": "https://data.1024tera.com/file/...m3u8..."
}
```

`download_url` is `null` when the original dlink is unavailable (anonymous
session → `errno 2`, share not accepted → `14`, `need verify_v2` → `400310`);
`stream_url` is the main HLS playlist window.  `GET /api/urls?url=…` works
too.  Extraction failures answer `502` exactly like `/api/info`.

```bash
curl -s http://127.0.0.1:8788/api/urls
# {"download_url": "https://...", "stream_url": "https://..."}
```

### `POST /api/extract` — async variant

Same body. Returns `202 {"id": "<job id>", "status": "queued"}` immediately;
poll `GET /api/jobs/:id` and read `result` for the envelope.

### `POST /api/download` — fetch a rendition

Body:

```json
{ "url": "https://...", "mode": "preview" | "original" }
```

| mode | What it fetches | Needs cookies | Duration |
|---|---|---|---|
| `preview` (default) | stitched 480p transcode → `<name>.preview480.ts` + `.mp4` (ffmpeg remux) | no | ~20-30 s logged in (harvest is 1 playlist fetch); ~1-2 min anonymous (random windows) |
| `original` | the original file → `<name>.mp4`, size + md5 verified | **yes** (else `400`) | ~10 min / 30 MB on free accounts |

Returns `202 {"id", "status", "mode"}`.

### `GET /api/jobs`

Job summaries, newest first (results omitted — they're large):

```json
{ "jobs": [ { "id": "ce8e10e7", "type": "download", "mode": "preview",
              "url": "...", "status": "done",
              "createdAt": "...", "startedAt": "...", "finishedAt": "...",
              "error": null,
              "progress": { "phase": "preview", "segment": 15, "segments": 15,
                            "bytes": 8758356, "total": 8758356, "at": "..." } } ] }
```

### `GET /api/jobs/:id`

Full job:

```jsonc
{
  "id": "...", "type": "extract|download", "mode": "preview|original|null",
  "status": "queued|running|done|failed|cancelled",
  "exitCode": 0, "error": null, "errors": [],
  "progress": { ... },       // latest phase event (see below)
  "logs": [ "...", ... ],    // bot output, capped at 300 lines
  "result": { ...envelope..., "files": [ ... ] }   // when done
}
```

**Statuses:** `queued → running → done | failed`; `cancelled` if removed while
queued. `DELETE` returns `409` for running jobs (they finish untouched).

**Progress phases:**

| phase | fields |
|---|---|
| `harvest` | `fid, segments, bytes, total, complete` — HLS window union |
| `original` | `chunk, chunks, bytes, total, kbps` — ranged download |
| `preview` | `segment, segments, bytes, total` — segment stitching |

### `DELETE /api/jobs/:id`

Cancel a **queued** job → `200 {"status":"cancelled"}`. Running jobs → `409`.
Unknown id → `404`.

### `GET /api/metadata?url=`

Same envelope as `POST /api/info`, URL as a query parameter. Kept for
convenience; prefer `POST /api/info` (payload URL).

### `GET /api/files`

```json
{ "dir": ".../output",
  "files": [ { "name": "Post 493 video 2.preview480.mp4", "size": 7752953,
               "mtime": "...", "url": "/api/files/Post%20493%20video%202.preview480.mp4" } ] }
```

### `GET /api/files/:name`

Streams the file with correct `content-type`, `content-length` and
`content-disposition: attachment`. Name is URL-encoded; path traversal outside
the output directory → `400`. Also supports `HEAD`.

---

## Job model

- **Queue:** jobs run FIFO with `--concurrency` slots (default **1**).
  Extraction uses the browser-free fast path — Chromium is launched only by
  the automatic fallback or `mode: "original"` jobs (~300-400 MB RAM).
- **`POST /api/info`, `POST /api/urls` and `GET /api/metadata` obey the same
  queue** — they wait
  for their slot before starting, so their latency = queue wait + ~3-8 s.
- **History:** last 100 jobs kept (oldest finished jobs drop out); logs capped
  at 300 lines per job.
- **Side effect:** every job writes `metadata.json` into the output directory;
  concurrent jobs therefore race on that one file (job `result.metadata` is
  always safe — it's captured per job).
- **Shutdown:** `SIGINT`/`SIGTERM` closes the server; in-flight jobs are
  aborted (Chromium may take a moment to reap).

---

## Errors

All errors are JSON: `{"error": "message"}` (job failures add `logs`).

| Status | When |
|---|---|
| `400` | invalid JSON body · `url` not `http(s)` · `mode: original` without `cookies.json` · path traversal |
| `404` | unknown job id · unknown file · unknown route |
| `409` | `DELETE` on a running job · sync call cancelled |
| `502` | sync call (`/api/info`, `/api/urls`, `/api/metadata`) job failed — body has `error` + tail of `logs` |
| `500` | unexpected server error |

A `202`'d job that later fails shows `status: "failed"` + `error` on
`GET /api/jobs/:id` — poll for it.

---

## Cookbook

```bash
BASE=http://127.0.0.1:8788

# 1) one-call info
curl -s -X POST $BASE/api/info -H 'content-type: application/json' \
     -d '{"url":"https://www.1024tera.com/sharing/link?surl=..."}'

# 1b) JUST the two URLs — {"download_url":"...","stream_url":"..."}
curl -s -X POST $BASE/api/urls -H 'content-type: application/json' -d '{}'

# 2) submit + poll until done (preview download)
ID=$(curl -s -X POST $BASE/api/download -d '{"mode":"preview"}' \
     | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
while :; do
  S=$(curl -s $BASE/api/jobs/$ID)
  echo "$S" | grep -qE '"status": "(done|failed|cancelled)"' && break
  sleep 5
done
echo "$S" | python3 -c 'import sys,json;j=json.load(sys.stdin);print(j["status"], j["result"]["files"] if j.get("result") else j["error"])'

# 3) grab the file
curl -s $BASE/api/files | python3 -c 'import sys,json;[print(f["url"]) for f in json.load(sys.stdin)["files"]]'
curl -O "$BASE/api/files/Post%20493%20video%202.preview480.mp4"

# 4) original quality (server-side, needs cookies.json; ~10 min)
curl -s -X POST $BASE/api/download -d '{"mode":"original"}'

# 5) watch a running job's progress + logs
curl -s $BASE/api/jobs/$ID | python3 -c 'import sys,json;j=json.load(sys.stdin);print(j["status"], j["progress"]);print("\n".join(j["logs"][-5:]))'
```

---

## Related

- `terabot.mjs` — the bot + CLI entry point (`node terabot.mjs [serve|login|help]`,
  or one-shot `node terabot.mjs --json …`); exported as `runTerabot(opts, hooks)`
  with `log` / `onProgress` hooks that feed this API's `logs` and `progress`.
- `login.mjs` — login flow → `cookies.json` (exported `runLogin`; run it with
  `node terabot.mjs login`).
- `README.md` — how the fast path, HLS window-harvest and original dlink work.
