#!/usr/bin/env python3
"""eval_cv5.py — strict tutorial20 eval for the CV+VLM solver.

Stage 1 (CV):  cand_v5.candidates() segments the scene into creature candidates
               with exact tap centers (cx,cy) and bboxes.
Stage 2 (VLM): ref cutout + grid of tight crops (one per candidate) -> model
               classifies each creature into the captcha's 5-slot grammar
               (body/wings/legs/head/tail) using the fixed vocabulary.
Stage 3 (CPU): exact 5-slot match vs ref -> taps. Traps differ in exactly one
               slot, so any mismatch is rejected; precision > recall.

Strict pass per example:
  - every zone covered by a tapped center (<=30px)
  - no tap within 30px of a near-trap point
  - no tap farther than 30px from every zone (false positive)

Usage: eval_cv5.py [N]     (default: all 20; N = first N examples)
"""
import json, math, sys, time, io, base64, urllib.request
from pathlib import Path

import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
import cand_v5

SHOTS = Path('/tmp/onlyfaucet-shots')
OUT = SHOTS / 'cvgrid'
OUT.mkdir(exist_ok=True)

VISION_HOST = 'https://ollama.com'
VISION_KEY = '9d800d83a8854b12afc5739fc7e6f691.R5TP5sR4H-LhTgMTvZgx7-OK'
VISION_MODEL = 'gemma4:31b'

CELL = 150           # grid cell size (crops are upscaled to roughly fill it)
COLS = 4
UP_CAP = 4.0         # max upscale for tiny fragments
HIT_R = 30           # zone coverage radius
DEDUPE_R = 20        # same-creature merge (widget untap radius is 18)

SLOTS = {
    'body':  ['bean-shaped body', 'oval body', 'six-sided body', 'spiky body', 'teardrop body'],
    'wings': ['a pointed wing', 'a round wing', 'no wings', 'one long wing', 'two wings'],
    'legs':  ['2 legs', '4 legs', 'no legs'],
    'head':  ['a long snout', 'a round head', 'no head (eyes on the body)'],
    'tail':  ['a curly tail', 'a fan tail', 'a forked tail', 'a thin tail', 'no tail'],
}

PROMPT = """Image 1 = REFERENCE creature (a cut-out of exactly one cartoon creature).
Image 2 = grid of numbered cells; each cell is a tight crop around ONE candidate creature from a scene. The cell's 1-based index is drawn in its top-left corner.

TASK
1. Classify the REFERENCE creature (Image 1).
2. Classify the main creature centered in EACH cell of Image 2 (the cell crop is centered on it).

Classify every creature using EXACTLY one value from each list below (copy the strings verbatim):
- body: bean-shaped body | oval body | six-sided body | spiky body | teardrop body
- wings: a pointed wing | a round wing | no wings | one long wing | two wings
- legs: 2 legs | 4 legs | no legs
- head: a long snout | a round head | no head (eyes on the body)
- tail: a curly tail | a fan tail | a forked tail | a thin tail | no tail

RULES
- IGNORE colour, colour pattern, size, left/right facing, pose, rotation.
- Judge only the construction: body outline shape, wings, leg count, head, tail.
- A cell that shows only a fragment (part of a creature cut off, e.g. only legs or only a tail), or debris/grass with no complete creature centered, must be "incomplete".
- Do not let other creatures partially visible at cell edges influence the classification of the centered creature.

Reply with ONLY a JSON object, no other text, in exactly this shape:
{"ref":{"body":"...","wings":"...","legs":"...","head":"...","tail":"..."},"cells":{"1":{"body":"...","wings":"...","legs":"...","head":"...","tail":"..."},"2":"incomplete", ...}}
Include EVERY cell index from 1 up to the highest number shown."""


def fit_crop(crop, cell=CELL, up_cap=UP_CAP):
    """Resize crop to fit cell (keep aspect), allowing limited upscale."""
    h, w = crop.shape[:2]
    scale = min(cell / w, cell / h, up_cap)
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    interp = cv2.INTER_CUBIC if scale > 1.05 else cv2.INTER_AREA
    im = Image.fromarray(cv2.cvtColor(cv2.resize(crop, (nw, nh), interpolation=interp),
                                      cv2.COLOR_BGR2RGB))
    out = Image.new('RGB', (cell, cell), (250, 250, 250))
    out.paste(im, ((cell - nw) // 2, (cell - nh) // 2))
    return out


def ref_crop(ref_bgr, cell=CELL):
    """Tight crop of the ref creature (light bg), fitted to a cell."""
    hsv = cv2.cvtColor(ref_bgr, cv2.COLOR_BGR2HSV)
    S, V = hsv[:, :, 1], hsv[:, :, 2]
    if float(np.median(V)) < 140:
        fg = (V > 105) | (V < 25)
    else:
        fg = (S > 42) | (V < 75)
    ys, xs = np.nonzero(fg)
    if len(ys) == 0:
        crop = ref_bgr
    else:
        m = 8
        x0, x1 = max(0, xs.min() - m), min(ref_bgr.shape[1], xs.max() + m)
        y0, y1 = max(0, ys.min() - m), min(ref_bgr.shape[0], ys.max() + m)
        crop = ref_bgr[y0:y1, x0:x1]
    return fit_crop(crop, cell)


def cand_crop(scene, c, cell=CELL):
    """Tight crop around a candidate's bbox (mask extent), fitted to a cell."""
    H, W = scene.shape[:2]
    mx = int(c['w'] * 0.12) + 6
    my = int(c['h'] * 0.12) + 6
    x0, y0 = max(0, c['x'] - mx), max(0, c['y'] - my)
    x1, y1 = min(W, c['x'] + c['w'] + mx), min(H, c['y'] + c['h'] + my)
    return fit_crop(scene[y0:y1, x0:x1], cell)


def build_grid(scene, cands):
    n = len(cands)
    rows = (n + COLS - 1) // COLS
    grid = Image.new('RGB', (COLS * CELL, rows * CELL), (255, 255, 255))
    draw = ImageDraw.Draw(grid)
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 28)
    except Exception:
        font = ImageFont.load_default()
    for idx, c in enumerate(cands):
        col, row = idx % COLS, idx // COLS
        ox, oy = col * CELL, row * CELL
        grid.paste(cand_crop(scene, c), (ox, oy))
        label = str(idx + 1)
        tw = draw.textlength(label, font=font)
        draw.rectangle([ox + 4, oy + 4, ox + 14 + tw, oy + 42],
                       fill=(255, 255, 255), outline=(0, 0, 0), width=2)
        draw.text((ox + 9, oy + 7), label, fill=(200, 0, 0), font=font)
        draw.rectangle([ox, oy, ox + CELL - 1, oy + CELL - 1], outline=(110, 110, 110))
    return grid


def b64img(pil_img):
    buf = io.BytesIO()
    pil_img.save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode()


def parse_json(content):
    txt = content.strip()
    if txt.startswith('```'):
        parts = txt.split('```')
        txt = parts[1] if len(parts) > 1 else txt
        if txt.startswith('json'):
            txt = txt[4:]
    start, end = txt.find('{'), txt.rfind('}')
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(txt[start:end + 1])
    except Exception:
        return None


def ask(ref_b64, grid_b64, n_cells, timeout=90):
    body = json.dumps({
        'model': VISION_MODEL,
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': PROMPT},
            {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + ref_b64}},
            {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + grid_b64}},
        ]}],
        'stream': False, 'max_tokens': 2600,
        'response_format': {'type': 'json_object'},
    }).encode()
    req = urllib.request.Request(VISION_HOST + '/v1/chat/completions', data=body, headers={
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + VISION_KEY})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read())
    ms = int((time.time() - t0) * 1000)
    content = (data.get('choices') or [{}])[0].get('message', {}).get('content', '')
    return parse_json(content), content, ms


def norm_slots(obj):
    """Return normalized 5-tuple dict or None if invalid/incomplete."""
    if not isinstance(obj, dict):
        return None
    out = {}
    for k, vocab in SLOTS.items():
        v = str(obj.get(k, '')).strip().lower().rstrip('.')
        if v not in [x.lower() for x in vocab]:
            return None
        out[k] = v
    return out


def match_taps(parsed, cands):
    """Exact 5-slot match vs ref -> tapped candidate indices (0-based)."""
    if not parsed:
        return None, {}, None
    ref = norm_slots(parsed.get('ref'))
    cells = parsed.get('cells') or {}
    feats = {}
    if ref is None:
        return [], feats, None
    picked = []
    for i in range(len(cands)):
        key = str(i + 1)
        val = cells.get(key, cells.get(i + 1))
        f = norm_slots(val)
        feats[key] = f
        if f is not None and f == ref:
            picked.append(i)
    return picked, feats, ref


def dedupe(picked, cands):
    """Merge matched candidates closer than DEDUPE_R px; keep largest area."""
    kept = []
    for idx in sorted(picked, key=lambda i: -cands[i]['area']):
        c = cands[idx]
        if any(math.hypot(c['cx'] - k['cx'], c['cy'] - k['cy']) < DEDUPE_R for k in kept):
            continue
        kept.append(c)
    return kept


def score(kept, ex):
    zones = ex['zones']
    nears = ex.get('near', [])
    hits = 0
    for z in zones:
        if any(math.hypot(k['cx'] - z[0], k['cy'] - z[1]) <= HIT_R for k in kept):
            hits += 1
    trap = any(math.hypot(k['cx'] - nn[0], k['cy'] - nn[1]) <= HIT_R
               for k in kept for nn in nears)
    fp = any(all(math.hypot(k['cx'] - z[0], k['cy'] - z[1]) > HIT_R
                 for z in zones) for k in kept)
    return hits == len(zones) and not trap and not fp, hits, trap, fp


def zone_cell_indices(cands, ex):
    """0-based candidate indices whose center is within HIT_R of a zone."""
    out = set()
    for i, c in enumerate(cands):
        if any(math.hypot(c['cx'] - z[0], c['cy'] - z[1]) <= HIT_R for z in ex['zones']):
            out.add(i)
    return out


def trap_cell_indices(cands, ex):
    out = set()
    for i, c in enumerate(cands):
        if any(math.hypot(c['cx'] - n[0], c['cy'] - n[1]) <= HIT_R
               for n in ex.get('near', [])):
            out.add(i)
    return out


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    R = json.load(open(SHOTS / 'tutorial20.json'))
    if limit:
        R = R[:limit]
    npass = 0
    ref_slot_ok = 0
    ref_slot_tot = 0
    cell_slot_ok = 0
    cell_slot_tot = 0
    t_total = time.time()
    for i, ex in enumerate(R):
        tag = f'cv{i:02d}'
        scene = cv2.imread(str(SHOTS / f'tut{i:02d}-scene.png'))
        ref = cv2.imread(str(SHOTS / f'tut{i:02d}-ref.png'))
        if scene is None or ref is None:
            print(f'{tag} MISSING images')
            continue
        t0 = time.time()
        cands, _, mode = cand_v5.candidates(scene)
        seg_ms = int((time.time() - t0) * 1000)
        if not cands:
            print(f'{tag} NO CANDIDATES')
            continue
        ref_img = ref_crop(ref)
        grid = build_grid(scene, cands)
        grid.save(OUT / f'{tag}-grid.png')
        ref_img.save(OUT / f'{tag}-ref.png')
        parsed, raw, ms = ask(b64img(ref_img), b64img(grid), len(cands))
        (OUT / f'{tag}.raw.txt').write_text(raw)
        if parsed is None:
            print(f'{tag} PARSE-FAIL vlm={ms}ms raw={raw[:160]!r}')
            continue
        picked, feats, ref_slots = match_taps(parsed, cands)
        if picked is None:
            print(f'{tag} REF-INVALID vlm={ms}ms ref={parsed.get("ref")!r}')
            continue
        kept = dedupe(picked, cands)
        ok, hits, trap, fp = score(kept, ex)
        npass += ok

        # --- diagnostics vs tutorial ground truth ---
        hint = [h.lower() for h in ex['hint']]
        # ref slot accuracy
        ref_acc = None
        if ref_slots:
            a = sum(1 for k, h in zip(SLOTS, hint) if ref_slots[k] == h)
            ref_slot_ok += a
            ref_slot_tot += len(hint)
            ref_acc = f'{a}/{len(hint)}'
        # zone/trap cell slot accuracy
        zidx = zone_cell_indices(cands, ex)
        tidx = trap_cell_indices(cands, ex)
        for idx in sorted(zidx):
            f = feats.get(str(idx + 1))
            if f:
                a = sum(1 for k, h in zip(SLOTS, hint) if f[k] == h)
                cell_slot_ok += a
                cell_slot_tot += len(hint)
        zinfo = ','.join(f'{i+1}:{"Y" if (feats.get(str(i+1)) or {}).get(k) else "?"}'
                         for i in sorted(zidx) for k in ['body'])
        taps = [(round(k['cx']), round(k['cy'])) for k in kept]
        print(f'{tag} {mode:5s} seg={seg_ms}ms vlm={ms}ms cand={len(cands)} '
              f'ref_acc={ref_acc} zones={hits}/{len(ex["zones"])} '
              f'trap={trap} fp={fp} {"PASS" if ok else "FAIL"} '
              f'zcells={[i+1 for i in sorted(zidx)]} tcells={[i+1 for i in sorted(tidx)]} '
              f'taps={taps}')
    print(f'=== {npass}/{len(R)} strict-pass; ref slots {ref_slot_ok}/{ref_slot_tot}; '
          f'zone-cell slots {cell_slot_ok}/{cell_slot_tot}; '
          f'{time.time() - t_total:.1f}s total')


if __name__ == '__main__':
    main()
