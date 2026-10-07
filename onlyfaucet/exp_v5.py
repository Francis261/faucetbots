#!/usr/bin/env python3
"""exp_v5.py — presentation experiments for ref/cell classification accuracy.

Variants:
  A: ref alone, large (300px), absolute slot classification
  B: ref+grid in one call, ABSOLUTE slots (current eval_cv5 approach)  [baseline: eval_cv5]
  C: ref+grid in one call, PAIRWISE per-cell "same as ref? which slots differ?"
  D: cells only (no ref image), absolute slots

Reports per-slot accuracy vs tutorial hint for ref and for zone cells,
plus trap-cell "match" rate (must be REJECTED) and fragment behavior.
Usage: exp_v5.py [variant A|C|D] [N]
"""
import json, math, sys, time, io, base64, urllib.request
from pathlib import Path

import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
import cand_v5
from eval_cv5 import (SHOTS, OUT, VISION_HOST, VISION_KEY, VISION_MODEL, CELL, COLS,
                      SLOTS, ref_crop, cand_crop, build_grid, b64img, parse_json,
                      norm_slots, zone_cell_indices, trap_cell_indices, HIT_R)

VOCAB_TEXT = """- body: bean-shaped body | oval body | six-sided body | spiky body | teardrop body
- wings: a pointed wing | a round wing | no wings | one long wing | two wings
- legs: 2 legs | 4 legs | no legs
- head: a long snout | a round head | no head (eyes on the body)
- tail: a curly tail | a fan tail | a forked tail | a thin tail | no tail"""

PROMPT_A = """Image 1 = one cartoon creature cut-out.

Classify it using EXACTLY one value from each list (copy verbatim):
""" + VOCAB_TEXT + """

IGNORE colour, colour pattern, size, facing direction, pose, rotation. Judge only construction: body outline shape, wings, leg count, head shape, tail shape.

Reply ONLY JSON: {"body":"...","wings":"...","legs":"...","head":"...","tail":"..."}"""

PROMPT_C = """Image 1 = REFERENCE creature (one cartoon creature cut-out).
Image 2 = grid of numbered cells; each cell is a tight crop centered on ONE candidate creature from a scene (index drawn top-left).

For EACH cell decide whether its centered creature is BUILT THE SAME as the reference: same body outline shape, same wings, same leg count, same head shape, same tail shape.

For each cell report which slots DIFFER from the reference using these slot names: body, wings, legs, head, tail.
Use these value names when a slot differs (value of the CELL creature):
""" + VOCAB_TEXT + """

Rules:
- IGNORE colour, pattern, size, facing, pose, rotation.
- A cell showing only a fragment (cut-off part of a creature, e.g. only legs/tail) or debris/grass with no complete creature centered -> "incomplete".
- Be precise: "differs" only if the construction genuinely differs (e.g. different tail SHAPE, different wing TYPE, 2 vs 4 legs). Similar-but-equal shapes are the SAME.

Reply ONLY JSON: {"cells":{"1":[],"2":["tail"],"3":"incomplete",...}}
Empty list [] = cell matches the reference exactly. Include EVERY cell index 1..N."""

PROMPT_D = """Image 1 = grid of numbered cells; each cell is a tight crop centered on ONE candidate creature from a scene (index drawn top-left).

Classify the main creature centered in EACH cell using EXACTLY one value from each list (copy verbatim):
""" + VOCAB_TEXT + """

Rules:
- IGNORE colour, colour pattern, size, facing direction, pose, rotation.
- Fragment cells (only part of a creature visible, or debris/grass) -> "incomplete".

Reply ONLY JSON: {"cells":{"1":{"body":"...","wings":"...","legs":"...","head":"...","tail":"..."},"2":"incomplete",...}}
Include EVERY cell index 1..N."""


PROMPT_E = """Image 1 = REFERENCE creature (one cartoon creature cut-out).
Image 2 = grid of numbered cells; each cell is a tight crop centered on ONE candidate creature from a scene (index drawn top-left).

For EACH cell compare its centered creature with the reference creature, SLOT BY SLOT.
Slots in order: body, wings, legs, head, tail.

Output a 5-character string per cell using:
  S = this slot is the SAME construction as the reference
  D = this slot DIFFERS from the reference
  X = cell is incomplete (only a fragment of a creature, or debris/grass, no complete creature centered)

Examples: "SSSSS" = identical construction. "SSDSD" = legs and tail differ.

What counts as DIFFERENT per slot:
- body: outline shape of the main body (hexagon-like vs smooth oval vs teardrop vs spiky/star vs bean/rounded-rectangle). Ignore size, colour, rotation.
- wings: presence/absence AND type on the creature's back (none / one round bump / one long pointed wing / two wings). A different number or a clearly different shape = D.
- legs: count of legs touching the ground (4 vs 2 vs none). Leg position/pose ignored.
- head: head shape at the front (long snout sticking out / round head / no head — eyes sit directly on the body).
- tail: tail shape at the rear (forked/V-split / curly curl / fan / thin straight line / none).

IGNORE colour, colour pattern, size, left/right facing, pose, rotation for every slot.

Reply ONLY JSON: {"cells":{"1":"SSSSS","2":"X","3":"DSSSS",...}}
Include EVERY cell index 1..N exactly once."""

PROMPT_F = """You will see ONE image containing several rows. Each row shows two cartoon creatures side by side: the LEFT creature in every row is the same REFERENCE creature, and the RIGHT creature is a numbered CANDIDATE (the row's number is drawn at its right edge).

For EACH row, decide whether the candidate is built the SAME way as the reference.

Reply with one 5-character string per row, one char per slot in order [body, wings, legs, head, tail]:
  S = same construction in this slot
  D = differs in this slot

Slot meanings:
- body: main body outline shape (hexagon-like / smooth oval / teardrop / spiky star / bean). Ignore size, colour, rotation.
- wings: presence/absence and type on the back (none / one round bump / one long wing / two wings).
- legs: count of legs touching the ground (4 / 2 / none).
- head: front head shape (long snout / round head / no head, eyes on body).
- tail: rear tail shape (forked / curly / fan / thin line / none).

IGNORE colour, pattern, size, facing direction, pose, rotation.

Reply ONLY JSON: {"cells":{"1":"SSSSS","2":"DSSSS",...}} with EVERY row number present."""


def ask(prompt, images, timeout=90, max_tokens=2600, temp=0.0):
    content_parts = [{'type': 'text', 'text': prompt}]
    for b64 in images:
        content_parts.append({'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + b64}})
    body = json.dumps({
        'model': VISION_MODEL,
        'messages': [{'role': 'user', 'content': content_parts}],
        'stream': False, 'max_tokens': max_tokens,
        'temperature': temp,
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


def big_ref(ref_bgr, cell=300):
    """Ref tight crop upscaled to a large single image."""
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
        m = 6
        x0, x1 = max(0, xs.min() - m), min(ref_bgr.shape[1], xs.max() + m)
        y0, y1 = max(0, ys.min() - m), min(ref_bgr.shape[0], ys.max() + m)
        crop = ref_bgr[y0:y1, x0:x1]
    h, w = crop.shape[:2]
    scale = min(cell / w, cell / h, 6.0)
    nw, nh = int(w * scale), int(h * scale)
    im = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_CUBIC)
    canvas = np.full((cell, cell, 3), 250, np.uint8)
    oy, ox = (cell - nh) // 2, (cell - nw) // 2
    canvas[oy:oy + nh, ox:ox + nw] = im
    return canvas


def build_pairs(scene, cands, ref, cols=3, pair_w=170, pair_h=150, pad=6):
    """Rows of [ref | candidate] pairs, one row per candidate, labeled 1..N.
    Returns one PIL image."""
    ref_img = big_ref(ref, pair_h)          # ref crop on pair_h canvas
    n = len(cands)
    rows = (n + cols - 1) // cols
    W = cols * (2 * pair_w + 3 * pad + 26)
    H = rows * (pair_h + 2 * pad + 4)
    canvas = Image.new('RGB', (W, H), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 26)
    except Exception:
        font = ImageFont.load_default()
    ref_pil = Image.fromarray(cv2.cvtColor(ref_img, cv2.COLOR_BGR2RGB)).resize(
        (pair_w, pair_h), Image.Resampling.LANCZOS)
    for idx, c in enumerate(cands):
        col, row = idx % cols, idx // cols
        ox = col * (2 * pair_w + 3 * pad + 26) + pad
        oy = row * (pair_h + 2 * pad + 4) + pad
        cand_pil = cand_crop(scene, c, cell=pair_h).resize((pair_w, pair_h), Image.Resampling.LANCZOS)
        canvas.paste(ref_pil, (ox, oy))
        canvas.paste(cand_pil, (ox + pair_w + pad, oy))
        label = str(idx + 1)
        tw = draw.textlength(label, font=font)
        tx = ox + 2 * pair_w + 2 * pad + (26 - tw) // 2
        draw.text((tx, oy + pair_h // 2 - 16), label, fill=(200, 0, 0), font=font)
        draw.rectangle([ox, oy, ox + 2 * pair_w + pad - 1, oy + pair_h - 1],
                       outline=(110, 110, 110))
    return canvas


def variant(variant, ex, i, cands, scene, ref):
    hint = [h.lower() for h in ex['hint']]
    zidx = sorted(zone_cell_indices(cands, ex))
    tidx = sorted(trap_cell_indices(cands, ex))
    res = {'i': i, 'variant': variant}
    if variant == 'A':
        parsed, raw, ms = ask(PROMPT_A, [b64img(Image.fromarray(cv2.cvtColor(big_ref(ref), cv2.COLOR_BGR2RGB)))])
        res['ms'] = ms
        if parsed:
            got = norm_slots(parsed)
            if got:
                res['ref_acc'] = sum(1 for k, h in zip(SLOTS, hint) if got[k] == h)
                res['ref_bad'] = {k: got[k] for k, h in zip(SLOTS, hint) if got[k] != h}
    elif variant == 'C':
        grid = build_grid(scene, cands)
        parsed, raw, ms = ask(PROMPT_C, [b64img(ref_crop(ref)), b64img(grid)])
        res['ms'] = ms
        if parsed:
            cells = parsed.get('cells') or {}
            match = [j for j in range(len(cands))
                     if isinstance(cells.get(str(j + 1)), list)]
            res['match_cells'] = [j + 1 for j in match]
            # strict: every zone cell matched, no trap cell matched, no fp cell
            # fp = matched but not within HIT_R of any zone
            zset, tset = set(zidx), set(tidx)
            matched = set(match)
            res['z_hit'] = len(zset & matched)
            res['z_tot'] = len(zset)
            res['trap_in'] = len(tset & matched)
            res['fp'] = len(matched - zset - tset)
    elif variant == 'D':
        grid = build_grid(scene, cands)
        parsed, raw, ms = ask(PROMPT_D, [b64img(grid)])
        res['ms'] = ms
        if parsed:
            cells = parsed.get('cells') or {}
            cell_ok = cell_tot = 0
            for j in zidx:
                f = norm_slots(cells.get(str(j + 1)))
                if f:
                    cell_ok += sum(1 for k, h in zip(SLOTS, hint) if f[k] == h)
                    cell_tot += len(hint)
            res['zone_acc'] = f'{cell_ok}/{cell_tot}'
    elif variant == 'E':
        grid = build_grid(scene, cands)
        parsed, raw, ms = ask(PROMPT_E, [b64img(ref_crop(ref)), b64img(grid)])
        res['ms'] = ms
        if parsed:
            cells = parsed.get('cells') or {}
            matched = []
            for j in range(len(cands)):
                v = cells.get(str(j + 1))
                if isinstance(v, str) and len(v) == 5 and set(v) <= set('SD') and 'D' not in v:
                    matched.append(j)
            zset, tset = set(zidx), set(tidx)
            mset = set(matched)
            res['z_hit'] = len(zset & mset)
            res['z_tot'] = len(zset)
            res['trap_in'] = len(tset & mset)
            res['fp'] = len(mset - zset - tset)
            res['raw_cells'] = {k: cells.get(str(k)) for k in [j + 1 for j in sorted(set(zidx) | tset)]}
    elif variant == 'F':
        pairs = build_pairs(scene, cands, ref)
        parsed, raw, ms = ask(PROMPT_F, [b64img(pairs)], max_tokens=800)
        res['ms'] = ms
        if parsed:
            cells = parsed.get('cells') or {}
            matched = []
            for j in range(len(cands)):
                v = cells.get(str(j + 1))
                if isinstance(v, str) and len(v) == 5 and set(v) <= set('SD') and 'D' not in v:
                    matched.append(j)
            zset, tset = set(zidx), set(tidx)
            mset = set(matched)
            res['z_hit'] = len(zset & mset)
            res['z_tot'] = len(zset)
            res['trap_in'] = len(tset & mset)
            res['fp'] = len(mset - zset - tset)
            res['raw_cells'] = {k: cells.get(str(k)) for k in [j + 1 for j in sorted(set(zidx) | tset)]}
    return res


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else 'ACD'
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    R = json.load(open(SHOTS / 'tutorial20.json'))[:limit]
    results = {v: [] for v in which}
    for i, ex in enumerate(R):
        scene = cv2.imread(str(SHOTS / f'tut{i:02d}-scene.png'))
        ref = cv2.imread(str(SHOTS / f'tut{i:02d}-ref.png'))
        cands, _, _ = cand_v5.candidates(scene)
        for v in which:
            try:
                r = variant(v, ex, i, cands, scene, ref)
            except Exception as e:
                r = {'i': i, 'variant': v, 'error': str(e)[:100]}
            results[v].append(r)
            print(v, json.dumps(r))
    # summaries
    for v in which:
        rs = results[v]
        if v == 'A':
            ok = sum(r.get('ref_acc', 0) for r in rs)
            print(f'== A ref slots {ok}/{5*len(rs)}')
            for r in rs:
                if r.get('ref_bad'): print('   ref_bad', r['i'], r['ref_bad'])
        elif v == 'C':
            zh = sum(r.get('z_hit', 0) for r in rs)
            zt = sum(r.get('z_tot', 0) for r in rs)
            ti = sum(r.get('trap_in', 0) for r in rs)
            fp = sum(r.get('fp', 0) for r in rs)
            print(f'== C zone-recall {zh}/{zt} trap-in {ti} fp {fp}')
        elif v == 'D':
            print('== D zone-cell acc per ex:', [r.get('zone_acc') for r in rs])
        elif v in 'EF':
            zh = sum(r.get('z_hit', 0) for r in rs)
            zt = sum(r.get('z_tot', 0) for r in rs)
            ti = sum(r.get('trap_in', 0) for r in rs)
            fp = sum(r.get('fp', 0) for r in rs)
            print(f'== {v} zone-recall {zh}/{zt} trap-in {ti} fp {fp}')
            for r in rs:
                if r.get('raw_cells'): print(f'   {v}{r["i"]:02d}', json.dumps(r['raw_cells']))


if __name__ == '__main__':
    main()
