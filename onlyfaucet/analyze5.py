#!/usr/bin/env python3
"""analyze5.py — combinations with few-shot ref (B2) replacing/augmenting B."""
import json, math, sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).parent))
import cand_v5
from eval_cv5 import SHOTS, HIT_R, DEDUPE_R, norm_slots
from analyze import cell_sets, dedupe_taps, strict

RA = json.load(open(SHOTS / 'run_all.json'))
PR = json.load(open(SHOTS / 'pair.json'))
FS = json.load(open(SHOTS / 'fs.json'))
R = json.load(open(SHOTS / 'tutorial20.json'))


def vB(res, n):
    if not res or 'ref' not in res or res.get('error') or not res.get('ref'):
        return None
    ref = res['ref']
    out = set()
    cells = res.get('cells') or {}
    for j in range(n):
        f = cells.get(str(j + 1))
        if f and f == ref:
            out.add(j)
    return out


def vB2(res, n, i):
    if not res or res.get('error'):
        return None
    ref = norm_slots((FS.get(str(i), {}) or {}).get('slots'))
    if not ref:
        return None
    out = set()
    cells = res.get('cells') or {}
    for j in range(n):
        f = cells.get(str(j + 1))
        if f and f == ref:
            out.add(j)
    return out


def vE(res, n):
    if not res or res.get('error') or not res.get('cells'):
        return None
    out = set()
    for j in range(n):
        v = res['cells'].get(str(j + 1))
        if isinstance(v, str):
            v = v.replace(' ', '')
            if len(v) == 5 and set(v) == {'S'}:
                out.add(j)
    return out


def vP(res, n):
    if not res or not res.get('done'):
        return None
    out = set()
    for j in range(n):
        v = (res.get('cells') or {}).get(str(j))
        if isinstance(v, str) and v == 'SSSSS':
            out.add(j)
    return out


def main():
    cell_list = [cell_sets(i) for i in range(len(R))]

    def maj(vs, need, n):
        if any(v is None for v in vs):
            return None
        return {j for j in range(n) if sum(j in v for v in vs) >= need}

    rules = {
        'B':            lambda b2, b, e, p, n: b,
        'B2':           lambda b2, b, e, p, n: b2,
        'maj3(B,E,P)':  lambda b2, b, e, p, n: maj([b, e, p], 2, n),
        'maj3(B2,E,P)': lambda b2, b, e, p, n: maj([b2, e, p], 2, n),
        'maj3(B2,B,P)': lambda b2, b, e, p, n: maj([b2, b, p], 2, n),
        'maj4(B2,B,E,P)': lambda b2, b, e, p, n: maj([b2, b, e, p], 3, n),
        'maj5(B2,B,E,P,+EP)': lambda b2, b, e, p, n: maj([b2, b, e, p, e], 3, n),
    }
    for name, fn in rules.items():
        npass = zhit = ztot = ntrap = nfp = 0
        fails = []
        for i in range(len(R)):
            cands, zc, tc, ex = cell_list[i]
            n = len(cands)
            b = vB(RA.get(str(i), {}).get('B'), n)
            b2 = vB2(RA.get(str(i), {}).get('B'), n, i)
            e = vE(RA.get(str(i), {}).get('E'), n)
            p = vP(PR.get(str(i), {}), n)
            m = fn(b2, b, e, p, n)
            if m is None:
                fails.append(f'{i}:nodata')
                continue
            kept = dedupe_taps(m, cands)
            ok, hits, trap, fp = strict(kept, ex)
            npass += ok
            zhit += hits
            ztot += len(ex['zones'])
            ntrap += trap
            nfp += fp
            if not ok:
                fails.append(f'{i}:{hits}/{len(ex["zones"])}'
                             f'{"T" if trap else ""}{"F" if fp else ""}')
        print(f'{name:22s} {npass:3d}/20 recall {zhit:2d}/{ztot}  traps {ntrap}  '
              f'fp {nfp}  {" ".join(fails)}')


if __name__ == '__main__':
    main()
