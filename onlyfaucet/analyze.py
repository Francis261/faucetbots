#!/usr/bin/env python3
"""analyze.py — offline combination analysis of run_all.json variants.

For each combination rule, compute per-example strict pass:
  taps = matched cells (deduped) -> zone coverage + no trap + no fp.
"""
import json, math, sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).parent))
import cand_v5
from eval_cv5 import SHOTS, HIT_R, DEDUPE_R, norm_slots, SLOTS

RA = json.load(open(SHOTS / 'run_all.json'))
R = json.load(open(SHOTS / 'tutorial20.json'))


def cell_sets(i):
    ex = R[i]
    scene = cv2.imread(str(SHOTS / f'tut{i:02d}-scene.png'))
    cands, _, _ = cand_v5.candidates(scene)
    zc, tc = set(), set()
    for j, c in enumerate(cands):
        if any(math.hypot(c['cx'] - z[0], c['cy'] - z[1]) <= HIT_R for z in ex['zones']):
            zc.add(j)
        if any(math.hypot(c['cx'] - n[0], c['cy'] - n[1]) <= HIT_R
               for n in ex.get('near', [])):
            tc.add(j)
    return cands, zc, tc, ex


def verdict_B(res, n):
    """match iff cell slots == ref slots (both valid)."""
    if not res or 'ref' not in res or res.get('error'):
        return None
    ref = res.get('ref')
    if not ref:
        return None
    out = set()
    cells = res.get('cells') or {}
    for j in range(n):
        f = cells.get(str(j + 1))
        if f and f == ref:
            out.add(j)
    return out


def verdict_SD(res, n):
    if not res or res.get('error') or not res.get('cells'):
        return None
    out = set()
    cells = res['cells']
    for j in range(n):
        v = cells.get(str(j + 1))
        if isinstance(v, str):
            v = v.replace(' ', '')
            if len(v) == 5 and set(v) == {'S'}:
                out.add(j)
    return out


def dedupe_taps(idxs, cands):
    kept = []
    for idx in sorted(idxs, key=lambda i: -cands[i]['area']):
        c = cands[idx]
        if any(math.hypot(c['cx'] - k['cx'], c['cy'] - k['cy']) < DEDUPE_R for k in kept):
            continue
        kept.append(c)
    return kept


def strict(kept, ex):
    hits = sum(1 for z in ex['zones']
               if any(math.hypot(k['cx'] - z[0], k['cy'] - z[1]) <= HIT_R for k in kept))
    trap = any(math.hypot(k['cx'] - n[0], k['cy'] - n[1]) <= HIT_R
               for k in kept for n in ex.get('near', []))
    fp = any(all(math.hypot(k['cx'] - z[0], k['cy'] - z[1]) > HIT_R for z in ex['zones'])
             for k in kept)
    return hits == len(ex['zones']) and not trap and not fp, hits, trap, fp


COMBOS = {
    'B':      lambda b, e, f: b,
    'E':      lambda b, e, f: e,
    'F':      lambda b, e, f: f,
    'E&F':    lambda b, e, f: None if (e is None or f is None) else (e & f),
    'E&B':    lambda b, e, f: None if (e is None or b is None) else (e & b),
    'F&B':    lambda b, e, f: None if (f is None or b is None) else (f & b),
    'E|F':    lambda b, e, f: None if (e is None or f is None) else (e | f),
    'E|B':    lambda b, e, f: None if (e is None or b is None) else (e | b),
    'maj3':   lambda b, e, f: None if None in (b, e, f)
              else set(),  # placeholder, handled specially below
}


def main():
    # precompute cell sets once
    cells = [cell_sets(i) for i in range(len(R))]
    n = len(R)
    print(f'{"rule":8s} pass  recall  traps fps  detail(fails)')
    for name, fn in COMBOS.items():
        npass = ztot = zhit = ntrap = nfp = 0
        fails = []
        for i in range(n):
            cands, zc, tc, ex = cells[i]
            res = RA.get(str(i), {})
            b = verdict_B(res.get('B'), len(cands))
            e = verdict_SD(res.get('E'), len(cands))
            f = verdict_SD(res.get('F'), len(cands))
            if name == 'maj3':
                if None in (b, e, f):
                    m = None
                else:
                    m = {j for j in range(len(cands))
                         if sum(j in s for s in (b, e, f)) >= 2}
            else:
                m = fn(b, e, f)
            if m is None:
                fails.append(f'{i}:no-data')
                continue
            kept = dedupe_taps(m, cands)
            ok, hits, trap, fp = strict(kept, ex)
            npass += ok
            ztot += len(ex['zones'])
            zhit += hits
            ntrap += trap
            nfp += fp
            if not ok:
                fails.append(f'{i}:{hits}/{len(ex["zones"])}'
                             f'{"T" if trap else ""}{"F" if fp else ""}')
        print(f'{name:8s} {npass:3d}/{n} {zhit:4d}/{ztot}  {ntrap:3d}  {nfp:3d}  '
              f'{" ".join(fails)}')


if __name__ == '__main__':
    main()
