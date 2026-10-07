#!/usr/bin/env python3
"""run_pair.py — variant P: one pairwise call per candidate (ref|cand side by side,
big images), S/D per slot. Parallel with a thread pool.

Dumps to /tmp/onlyfaucet-shots/pair.json: {ex_idx: {"cells": {"1": "SSSSS", ...}, ...}}
"""
import json, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
import cand_v5
from eval_cv5 import SHOTS, ref_crop, cand_crop, b64img
from exp_v5 import ask, big_ref, PROMPT_F

PAIR_W, PAIR_H = 210, 186

PROMPT_P = """Image shows TWO cartoon creatures side by side.
LEFT = the REFERENCE creature. RIGHT = the CANDIDATE creature.

Compare them slot by slot: are they built the SAME way?

Slots in order [body, wings, legs, head, tail]:
- body: main body outline shape (hexagon-like / smooth oval / teardrop / spiky star / bean). Ignore size, colour, rotation.
- wings: presence/absence and type on the back (none / one round bump / one long wing / two wings).
- legs: count of legs touching the ground (4 / 2 / none).
- head: front head shape (long snout / round head / no head, eyes directly on body).
- tail: rear tail shape (forked / curly / fan / thin line / none).

IGNORE colour, colour pattern, size, facing direction, pose, rotation.

Reply ONLY JSON: {"slots":"....."} with exactly 5 chars: S = same construction in that slot, D = differs."""


def pair_image(scene, cands, ref, j):
    ref_img = cv2.resize(big_ref(ref, PAIR_H), (PAIR_W, PAIR_H), interpolation=cv2.INTER_AREA)
    cand = cv2.cvtColor(np.array(cand_crop(scene, cands[j], cell=PAIR_H)), cv2.COLOR_RGB2BGR)
    cand_img = cv2.resize(cand, (PAIR_W, PAIR_H), interpolation=cv2.INTER_AREA)
    pair = np.full((PAIR_H, 2 * PAIR_W + 8, 3), 255, np.uint8)
    pair[:, :PAIR_W] = ref_img
    pair[:, PAIR_W + 8:] = cand_img
    return Image.fromarray(cv2.cvtColor(pair, cv2.COLOR_BGR2RGB))


def one_call(i, j, scene, cands, ref):
    img = pair_image(scene, cands, ref, j)
    parsed, raw, ms = ask(PROMPT_P, [b64img(img)], max_tokens=60)
    slots = (parsed or {}).get('slots')
    if isinstance(slots, str):
        slots = slots.replace(' ', '')
        if len(slots) != 5 or set(slots) - set('SD'):
            slots = None
    return i, j, slots, ms, None if slots else raw[:150]


def main():
    R = json.load(open(SHOTS / 'tutorial20.json'))
    out_path = SHOTS / 'pair.json'
    results = json.load(open(out_path)) if out_path.exists() else {}
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else len(R)
    workers = int(sys.argv[2]) if len(sys.argv) > 2 else 6

    jobs = []
    for i in range(limit):
        key = str(i)
        if results.get(key, {}).get('done'):
            continue
        scene = cv2.imread(str(SHOTS / f'tut{i:02d}-scene.png'))
        ref = cv2.imread(str(SHOTS / f'tut{i:02d}-ref.png'))
        cands, _, _ = cand_v5.candidates(scene)
        results.setdefault(key, {'n_cand': len(cands)})
        results[key]['n_cand'] = len(cands)
        for j in range(len(cands)):
            if str(j) not in results[key]:
                jobs.append((i, j, scene, cands, ref))

    print(f'{len(jobs)} calls to make with {workers} workers')
    t0 = time.time()
    by_ex = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(one_call, *job) for job in jobs]
        for fu in as_completed(futs):
            i, j, slots, ms, err = fu.result()
            by_ex.setdefault(i, {})[str(j)] = slots
            if err:
                by_ex[i][str(j)] = {'error': err}
            print(f'ex{i:02d} cell{j} -> {slots} {ms}ms' + (f' ERR={err}' if err else ''),
                  flush=True)
    for i, cells in by_ex.items():
        results[str(i)]['cells'] = cells
        results[str(i)]['done'] = True
        json.dump(results, open(out_path, 'w'), indent=1)
    print(f'saved {out_path} in {time.time()-t0:.0f}s')


if __name__ == '__main__':
    main()
