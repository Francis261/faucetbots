#!/usr/bin/env python3
"""analyze3.py — strict eval of pairwise P (pair.json), standalone and combined
with grid variants E and B (run_all.json)."""
import json, math, sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).parent))
import cand_v5
from eval_cv5 import SHOTS, HIT_R, DEDUPE_R
from analyze import cell_sets, dedupe_taps, strict

RA = json.load(open(SHOTS / 'run_all.json'))
PR = json.load(open(SHOTS / 'pair.json'))
R = json.load(open(SHOTS / 'tutorial20.json'))


def verdict_P(res, n):
    if not res or not res.get('done'):
        return None
    cells = res.get('cells') or {}
    out = set()
    for j in range(n):
        v = cells.get(str(j))
        if isinstance(v, str) and v == 'SSSSS':
            out.add(j)
    return out


def verdict_E(res, n):
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


def verdict_B(res, n):
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


def main():
    cells = [cell_sets(i) for i in range(len(R))]
    rules = {}
    rules['P'] = lambda b, e, p: p
    rules['E'] = lambda b, e, p: e
    rules['B'] = lambda b, e, p: b
    rules['P&E'] = lambda b, e, p: None if None in (p, e) else p & e
    rules['P&B'] = lambda b, e, p: None if None in (p, b) else p & b
    rules['E&B'] = lambda b, e, p: None if None in (e, b) else e & b
    rules['P|E'] = lambda b, e, p: None if None in (p, e) else p | e
    rules['majPE'] = lambda b, e, p: None if None in (p, e) else (
        p if p == e else (p & e))
    rules['maj3'] = None  # special

    for name, fn in rules.items():
        npass = zhit = ztot = ntrap = nfp = 0
        fails = []
        for i in range(len(R)):
            cands, zc, tc, ex = cells[i]
            b = verdict_B(RA.get(str(i), {}).get('B'), len(cands))
            e = verdict_E(RA.get(str(i), {}).get('E'), len(cands))
            p = verdict_P(PR.get(str(i), {}), len(cands))
            if name == 'maj3':
                if None in (b, e, p):
                    m = None
                else:
                    m = {j for j in range(len(cands))
                         if sum(j in s for s in (b, e, p)) >= 2}
            else:
                m = fn(b, e, p)
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
        print(f'{name:7s} {npass:3d}/20  recall {zhit:2d}/{ztot}  traps {ntrap}  '
              f'fp {nfp}  {" ".join(fails)}')


if __name__ == '__main__':
    main()
