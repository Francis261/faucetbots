#!/usr/bin/env python3
"""run_div.py — diverse voters for maj5:
  E2: ref-vs-grid S/D with SHUFFLED cell order (labels keep original indices)
  P2: pairwise with sides SWAPPED (candidate LEFT, ref RIGHT)

Dumps /tmp/onlyfaucet-shots/div.json: {ex: {"E2": {...}, "P2": {cells...}}}
"""
import json, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
import cand_v5
from eval_cv5 import SHOTS, ref_crop, cand_crop, b64img, CELL, COLS
from exp_v5 import ask, PROMPT_E, big_ref
from run_pair import PROMPT_P, PAIR_W, PAIR_H, pair_image

OUT = SHOTS / 'div.json'

PROMPT_P2 = PROMPT_P.replace(
    'LEFT = the REFERENCE creature. RIGHT = the CANDIDATE creature.',
    'LEFT = the CANDIDATE creature. RIGHT = the REFERENCE creature.')

PROMPT_E2 = PROMPT_E  # same task; layout change provides the diversity


def build_grid_ord(scene, cands, order):
    """Grid in `order` permutation; labels = ORIGINAL 1-based index."""
    rows = (len(cands) + COLS - 1) // COLS
    grid = Image.new('RGB', (COLS * CELL, rows * CELL), (255, 255, 255))
    draw = ImageDraw.Draw(grid)
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 28)
    except Exception:
        font = ImageFont.load_default()
    for pos, j in enumerate(order):
        col, row = pos % COLS, pos // COLS
        ox, oy = col * CELL, row * CELL
        grid.paste(cand_crop(scene, cands[j]), (ox, oy))
        label = str(j + 1)
        tw = draw.textlength(label, font=font)
        draw.rectangle([ox + 4, oy + 4, ox + 14 + tw, oy + 42],
                       fill=(255, 255, 255), outline=(0, 0, 0), width=2)
        draw.text((ox + 9, oy + 7), label, fill=(200, 0, 0), font=font)
        draw.rectangle([ox, oy, ox + CELL - 1, oy + CELL - 1], outline=(110, 110, 110))
    return grid


def pair_image2(scene, cands, ref, j):
    """candidate LEFT, ref RIGHT."""
    ref_img = cv2.resize(big_ref(ref, PAIR_H), (PAIR_W, PAIR_H), interpolation=cv2.INTER_AREA)
    cand = cv2.cvtColor(np.array(cand_crop(scene, cands[j], cell=PAIR_H)), cv2.COLOR_RGB2BGR)
    cand_img = cv2.resize(cand, (PAIR_W, PAIR_H), interpolation=cv2.INTER_AREA)
    pair = np.full((PAIR_H, 2 * PAIR_W + 8, 3), 255, np.uint8)
    pair[:, :PAIR_W] = cand_img
    pair[:, PAIR_W + 8:] = ref_img
    return Image.fromarray(cv2.cvtColor(pair, cv2.COLOR_BGR2RGB))


def job_E2(i, scene, ref, cands, order):
    parsed, raw, ms = ask(PROMPT_E2, [b64img(ref_crop(ref)),
                                      b64img(build_grid_ord(scene, cands, order))])
    cells = (parsed or {}).get('cells') or {}
    out = {}
    for j in range(len(cands)):
        s = cells.get(str(j + 1), cells.get(j + 1))
        out[str(j)] = s if isinstance(s, str) else None
    return i, 'E2', out, ms


def job_P2(i, j, scene, cands, ref):
    img = pair_image2(scene, cands, ref, j)
    parsed, raw, ms = ask(PROMPT_P2, [b64img(img)], max_tokens=60)
    s = (parsed or {}).get('slots')
    if isinstance(s, str):
        s = s.replace(' ', '')
        if len(s) != 5 or set(s) - set('SD'):
            s = None
    return i, 'P2', j, s, ms


def main():
    R = json.load(open(SHOTS / 'tutorial20.json'))
    results = json.load(open(OUT)) if OUT.exists() else {}
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else len(R)
    workers = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    rng = np.random.default_rng(7)

    e2_jobs, p2_jobs = [], []
    for i in range(limit):
        key = str(i)
        res = results.setdefault(key, {})
        scene = cv2.imread(str(SHOTS / f'tut{i:02d}-scene.png'))
        ref = cv2.imread(str(SHOTS / f'tut{i:02d}-ref.png'))
        cands, _, _ = cand_v5.candidates(scene)
        res['n_cand'] = len(cands)
        if 'E2' not in res:
            order = rng.permutation(len(cands)).tolist()
            e2_jobs.append((i, scene, ref, cands, order))
        for j in range(len(cands)):
            if str(j) not in res.get('P2', {}):
                p2_jobs.append((i, j, scene, cands, ref))

    print(f'{len(e2_jobs)} E2 + {len(p2_jobs)} P2 calls, {workers} workers')
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(job_E2, *jb) for jb in e2_jobs]
        futs += [pool.submit(job_P2, *jb) for jb in p2_jobs]
        for fu in as_completed(futs):
            r = fu.result()
            if r[1] == 'E2':
                i, _, cells, ms = r
                results[str(i)]['E2'] = cells
                print(f'ex{i:02d} E2 done {ms}ms', flush=True)
            else:
                i, _, j, s, ms = r
                results[str(i)].setdefault('P2', {})[str(j)] = s
                print(f'ex{i:02d} P2 cell{j} -> {s} {ms}ms', flush=True)
    json.dump(results, open(OUT, 'w'), indent=1)
    print(f'saved {OUT} in {time.time()-t0:.0f}s')


if __name__ == '__main__':
    main()
