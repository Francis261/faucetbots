#!/usr/bin/env python3
"""run_rep.py — replicate samples for the noisy signals E, E2, P2.

Two NEW samples each (original lives in run_all.json / div.json), giving
3 samples total per signal for per-cell majority voting:
  E_b, E_c   : same deterministic grid (pure VLM variance)
  E2_b, E2_c : DIFFERENT shuffled orders (layout + VLM variance)
  P2_b, P2_c : identical pair image (pure VLM variance)

Dumps /tmp/onlyfaucet-shots/rep.json.
"""
import json, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import cand_v5
from eval_cv5 import SHOTS, ref_crop, build_grid, b64img
from exp_v5 import ask, PROMPT_E
from run_div import PROMPT_P2, build_grid_ord, pair_image2

OUT = SHOTS / 'rep.json'
SAMPLES = ('b', 'c')


def job_E(i, scene, ref, cands, sfx):
    parsed, raw, ms = ask(PROMPT_E, [b64img(ref_crop(ref)),
                                     b64img(build_grid(scene, cands))])
    cells = (parsed or {}).get('cells') or {}
    out = {}
    for j in range(len(cands)):
        s = cells.get(str(j + 1), cells.get(j + 1))
        out[str(j)] = s if isinstance(s, str) else None
    return i, 'E_' + sfx, out, ms


def job_E2(i, scene, ref, cands, order, sfx):
    parsed, raw, ms = ask(PROMPT_E, [b64img(ref_crop(ref)),
                                     b64img(build_grid_ord(scene, cands, order))])
    cells = (parsed or {}).get('cells') or {}
    out = {}
    for j in range(len(cands)):
        s = cells.get(str(j + 1), cells.get(j + 1))
        out[str(j)] = s if isinstance(s, str) else None
    return i, 'E2_' + sfx, out, ms


def job_P2(i, j, scene, cands, ref, sfx):
    img = pair_image2(scene, cands, ref, j)
    parsed, raw, ms = ask(PROMPT_P2, [b64img(img)], max_tokens=60)
    s = (parsed or {}).get('slots')
    if isinstance(s, str):
        s = s.replace(' ', '')
        if len(s) != 5 or set(s) - set('SD'):
            s = None
    return i, 'P2_' + sfx, j, s, ms


def main():
    R = json.load(open(SHOTS / 'tutorial20.json'))
    results = json.load(open(OUT)) if OUT.exists() else {}
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else len(R)
    workers = int(sys.argv[2]) if len(sys.argv) > 2 else 6

    e_jobs, p_jobs = [], []
    for i in range(limit):
        res = results.setdefault(str(i), {})
        scene = cv2.imread(str(SHOTS / f'tut{i:02d}-scene.png'))
        ref = cv2.imread(str(SHOTS / f'tut{i:02d}-ref.png'))
        cands, _, _ = cand_v5.candidates(scene)
        res['n_cand'] = len(cands)
        for sfx in SAMPLES:
            if f'E_{sfx}' not in res:
                e_jobs.append(('E', i, scene, ref, cands, sfx))
            if f'E2_{sfx}' not in res:
                order = np.random.default_rng(1000 + i * 7 + ord(sfx)).permutation(len(cands)).tolist()
                e_jobs.append(('E2', i, scene, ref, cands, order, sfx))
            for j in range(len(cands)):
                if str(j) not in res.get('P2_' + sfx, {}):
                    p_jobs.append((i, j, scene, cands, ref, sfx))

    print(f'{len(e_jobs)} grid + {len(p_jobs)} pair calls, {workers} workers')
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = []
        for jb in e_jobs:
            fn = job_E2 if jb[0] == 'E2' else job_E
            futs.append(pool.submit(fn, *jb[1:]))
        futs += [pool.submit(job_P2, *jb) for jb in p_jobs]
        done = 0
        for fu in as_completed(futs):
            r = fu.result()
            if len(r) == 4:
                i, key, cells, ms = r
                results[str(i)][key] = cells
            else:
                i, key, j, s, ms = r
                results[str(i)].setdefault(key, {})[str(j)] = s
            done += 1
            if done % 40 == 0:
                print(f'{done} done ({time.time()-t0:.0f}s)', flush=True)
    json.dump(results, open(OUT, 'w'), indent=1)
    print(f'saved {OUT} in {time.time()-t0:.0f}s')


if __name__ == '__main__':
    main()
