#!/usr/bin/env python3
"""run_sil.py — variant Ps: pairwise comparison on BINARY SILHOUETTES.

Removes colour/pattern/background confounds (the main source of phantom D's):
white background, black creature shape (strokes + fills from the same fg rule
used for segmentation).

Dumps to /tmp/onlyfaucet-shots/sil.json: {ex_idx: {"cells": {"0": "SSSSS"}}}
"""
import json, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent))
import cand_v5
from eval_cv5 import SHOTS, b64img
from exp_v5 import ask
from run_pair import PROMPT_P, PAIR_W, PAIR_H

OUT = SHOTS / 'sil.json'


def raw_fg(bgr, mode):
    """RAW adaptive fg rule (no morphology) so thin strokes (legs/tails/
    antennae) survive; the processed segmentation mask erodes them."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    S, V = hsv[:, :, 1], hsv[:, :, 2]
    if mode == 'dark':
        fg = ((V > 105) | (V < 25)).astype(np.uint8) * 255
    else:
        # V<115 (not the segmenter's 75): antialiased/faint stroke segments
        # count too, so thin tails/legs read as solid lines, not dashes
        fg = ((S > 42) | (V < 115)).astype(np.uint8) * 255
    return fg


def sil_from(bgr, mode, x0, y0, x1, y1):
    """Render white-bg / black-shape silhouette from a region."""
    sub = raw_fg(bgr[y0:y1, x0:x1], mode)
    # reconnect antialias gaps in thin strokes (tails/legs), then drop speckle
    # (confetti/bg noise) but keep thin strokes: legs are few pixels yet >=4px
    k5 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    sub = cv2.morphologyEx(sub, cv2.MORPH_CLOSE, k5)
    n, lab, stats, _ = cv2.connectedComponentsWithStats((sub > 0).astype(np.uint8), 8)
    keep = np.zeros(sub.shape, bool)
    for k in range(1, n):
        w, h, area = stats[k, 2], stats[k, 3], stats[k, 4]
        if area >= 6 and max(w, h) >= 4:
            keep |= lab == k
    sub = np.where(keep, 255, 0).astype(np.uint8)
    # fill interior holes so pattern gaps don't read as shape detail
    h, w = sub.shape[:2]
    if h > 2 and w > 2:
        ff = sub.copy()
        mask = np.zeros((h + 2, w + 2), np.uint8)
        cv2.floodFill(ff, mask, (0, 0), 255)
        cv2.floodFill(ff, mask, (w - 1, h - 1), 255)
        sub = sub | cv2.bitwise_not(ff)
    out = np.full((h, w, 3), 255, np.uint8)
    out[sub > 0] = (20, 20, 20)
    return out


def fit(bgr, cell_w, cell_h):
    h, w = bgr.shape[:2]
    scale = min(cell_w / w, cell_h / h)
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    im = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_AREA)
    out = np.full((cell_h, cell_w, 3), 255, np.uint8)
    oy, ox = (cell_h - nh) // 2, (cell_w - nw) // 2
    out[oy:oy + nh, ox:ox + nw] = im
    return out


def pair_image(scene, mode, cands, ref_bgr, j):
    H, W = scene.shape[:2]
    c = cands[j]
    mx, my = int(c['w'] * 0.12) + 6, int(c['h'] * 0.12) + 6
    x0, y0 = max(0, c['x'] - mx), max(0, c['y'] - my)
    x1, y1 = min(W, c['x'] + c['w'] + mx), min(H, c['y'] + c['h'] + my)
    cand_sil = sil_from(scene, mode, x0, y0, x1, y1)

    hsv = cv2.cvtColor(ref_bgr, cv2.COLOR_BGR2HSV)
    rmode = 'dark' if float(np.median(hsv[:, :, 2])) < 140 else 'light'
    rfg = raw_fg(ref_bgr, rmode)
    ys, xs = np.nonzero(rfg)
    m = 8
    rx0, rx1 = max(0, xs.min() - m), min(ref_bgr.shape[1], xs.max() + m)
    ry0, ry1 = max(0, ys.min() - m), min(ref_bgr.shape[0], ys.max() + m)
    ref_sil = sil_from(ref_bgr, rmode, rx0, ry0, rx1, ry1)

    left = fit(ref_sil, PAIR_W, PAIR_H)
    right = fit(cand_sil, PAIR_W, PAIR_H)
    pair = np.full((PAIR_H, 2 * PAIR_W + 8, 3), 255, np.uint8)
    pair[:, :PAIR_W] = left
    pair[:, PAIR_W + 8:] = right
    return Image.fromarray(cv2.cvtColor(pair, cv2.COLOR_BGR2RGB))


def one_call(i, j, scene, mode, cands, ref):
    img = pair_image(scene, mode, cands, ref, j)
    parsed, raw, ms = ask(PROMPT_P, [b64img(img)], max_tokens=60)
    slots = (parsed or {}).get('slots')
    if isinstance(slots, str):
        slots = slots.replace(' ', '')
        if len(slots) != 5 or set(slots) - set('SD'):
            slots = None
    return i, j, slots, ms, None if slots else raw[:150]


def main():
    R = json.load(open(SHOTS / 'tutorial20.json'))
    results = json.load(open(OUT)) if OUT.exists() else {}
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else len(R)
    workers = int(sys.argv[2]) if len(sys.argv) > 2 else 6

    jobs = []
    for i in range(limit):
        key = str(i)
        if results.get(key, {}).get('done'):
            continue
        scene = cv2.imread(str(SHOTS / f'tut{i:02d}-scene.png'))
        ref = cv2.imread(str(SHOTS / f'tut{i:02d}-ref.png'))
        cands, mask, mode = cand_v5.candidates(scene)
        results.setdefault(key, {})
        results[key]['n_cand'] = len(cands)
        for j in range(len(cands)):
            if str(j) not in results[key].get('cells', {}):
                jobs.append((i, j, scene, mode, cands, ref))

    print(f'{len(jobs)} calls with {workers} workers')
    t0 = time.time()
    by_ex = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(one_call, *job) for job in jobs]
        for fu in as_completed(futs):
            i, j, slots, ms, err = fu.result()
            by_ex.setdefault(i, {}).setdefault('cells', {})[str(j)] = slots
            print(f'ex{i:02d} cell{j} -> {slots} {ms}ms' + (f' ERR={err}' if err else ''),
                  flush=True)
    for i, res in by_ex.items():
        results[str(i)].update(res)
        results[str(i)]['done'] = True
    json.dump(results, open(OUT, 'w'), indent=1)
    print(f'saved {OUT} in {time.time()-t0:.0f}s')


if __name__ == '__main__':
    main()
