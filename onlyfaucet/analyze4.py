#!/usr/bin/env python3
"""analyze4.py — per-slot majority voting across B, E, P (and subsets)."""
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
SLOT = ['body', 'wings', 'legs', 'head', 'tail']


def votes(i, n):
    """per cell -> {'B_body': bool|None, 'E_body': ..., 'P_body': ...}"""
    res = RA.get(str(i), {})
    out = [dict() for _ in range(n)]
    b = res.get('B') or {}
    refb = b.get('ref')
    if refb and not b.get('error'):
        cells = b.get('cells') or {}
        for j in range(n):
            f = cells.get(str(j + 1))
            if f:
                for k in SLOT:
                    out[j]['B_' + k] = f.get(k) == refb.get(k)
    e = res.get('E') or {}
    if e.get('cells') and not e.get('error'):
        for j in range(n):
            s = e['cells'].get(str(j + 1))
            if isinstance(s, str):
                s = s.replace(' ', '')
                if len(s) == 5 and set(s) <= set('SD'):
                    for k, ch in zip(SLOT, s):
                        out[j]['E_' + k] = (ch == 'S')
    pcells = (PR.get(str(i), {}) or {}).get('cells') or {}
    for j in range(n):
        s = pcells.get(str(j))
        if isinstance(s, str):
            for k, ch in zip(SLOT, s):
                out[j]['P_' + k] = (ch == 'S')
    return out


def cell_match(v, variant_keys, need):
    """cell matches iff >=need of the given variants vote S on EVERY slot."""
    for k in SLOT:
        vals = [v.get(f'{vk}_{k}') for vk in variant_keys]
        vals = [x for x in vals if x is not None]
        if not vals:
            return False
        if sum(vals) < need:
            return False
    return True


RULES = {
    'slot-maj3(2/3)':   (['B', 'E', 'P'], 2),
    'slot-maj5(3/5)':   (['B', 'E', 'P', 'E', 'P'], 3),  # dup keys collapse, see below
    'slot-and3':        (['B', 'E', 'P'], 3),
    'slot-majEP(1/2)':  (['E', 'P'], 1),
    'slot-andEP':       (['E', 'P'], 2),
    'slot-majBP(2/2)':  (['B', 'P'], 2),
    'slot-majBE(2/2)':  (['B', 'E'], 2),
}


def main():
    cells = [cell_sets(i) for i in range(len(R))]
    for name, (keys, need) in RULES.items():
        if name == 'slot-maj5(3/5)':
            continue  # needs real duplicates; skip
        npass = zhit = ztot = ntrap = nfp = 0
        fails = []
        for i in range(len(R)):
            cands, zc, tc, ex = cells[i]
            vs = votes(i, len(cands))
            matched = {j for j in range(len(cands)) if cell_match(vs[j], keys, need)}
            kept = dedupe_taps(matched, cands)
            ok, hits, trap, fp = strict(kept, ex)
            npass += ok
            zhit += hits
            ztot += len(ex['zones'])
            ntrap += trap
            nfp += fp
            if not ok:
                fails.append(f'{i}:{hits}/{len(ex["zones"])}'
                             f'{"T" if trap else ""}{"F" if fp else ""}')
        print(f'{name:16s} {npass:3d}/20  recall {zhit:2d}/{ztot}  traps {ntrap}  '
              f'fp {nfp}  {" ".join(fails)}')


if __name__ == '__main__':
    main()
