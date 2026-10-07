#!/usr/bin/env python3
"""analyze2.py — per-slot combination analysis of run_all.json.

For each cell and each of the 5 slots, derive a match/mismatch vote from each
variant, then combine per-slot (majority etc.) -> cell matches iff all slots win.
"""
import json, math, sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).parent))
import cand_v5
from eval_cv5 import SHOTS, HIT_R, DEDUPE_R, norm_slots
from analyze import cell_sets, dedupe_taps, strict

RA = json.load(open(SHOTS / 'run_all.json'))
R = json.load(open(SHOTS / 'tutorial20.json'))
SLOT_KEYS = ['body', 'wings', 'legs', 'head', 'tail']


def slot_votes(i, n_cand):
    """Per cell per slot: dict variant -> True(match)/False(diff)/None(abstain)."""
    res = RA.get(str(i), {})
    out = [{v: None for v in 'BEF'} for _ in range(n_cand)]
    # B
    b = res.get('B') or {}
    refb = b.get('ref')
    if refb and not b.get('error'):
        cells = b.get('cells') or {}
        for j in range(n_cand):
            f = cells.get(str(j + 1))
            if f:
                out[j]['B'] = all(f.get(k) == refb.get(k) for k in SLOT_KEYS) \
                    if False else None  # per-slot filled below
                for k in SLOT_KEYS:
                    out[j]['B_' + k] = f.get(k) == refb.get(k)
    # E, F: string chars
    for v in 'EF':
        r = res.get(v) or {}
        cells = r.get('cells') or {}
        for j in range(n_cand):
            s = cells.get(str(j + 1))
            if isinstance(s, str):
                s = s.replace(' ', '')
                if len(s) == 5 and set(s) <= set('SD'):
                    for k, ch in zip(SLOT_KEYS, s):
                        out[j][f'{v}_{k}'] = (ch == 'S')
    return out


def combine(votes, rule):
    cell_match = True
    for k in SLOT_KEYS:
        bs = votes.get('B_' + k)
        es = votes.get('E_' + k)
        fs = votes.get('F_' + k)
        vals = [x for x in (bs, es, fs) if x is not None]
        if not vals:
            cell_match = False
            break
        if rule == 'maj':
            win = sum(vals) >= (len(vals) + 1) // 2 + (0 if len(vals) < 3 else 0)
            win = sum(vals) * 2 > len(vals)  # strict majority
        elif rule == 'and':
            win = all(vals)
        elif rule == 'or':
            win = any(vals)
        elif rule == 'maj3hard':  # majority of 3, abstainers count as mismatch
            win = sum(1 for x in (bs, es, fs) if x) >= 2
        if not win:
            cell_match = False
            break
    return cell_match


def main():
    cells = [cell_sets(i) for i in range(len(R))]
    for rule in ('maj', 'and', 'or', 'maj3hard'):
        npass = zhit = ztot = ntrap = nfp = 0
        fails = []
        for i in range(len(R)):
            cands, zc, tc, ex = cells[i]
            votes = slot_votes(i, len(cands))
            matched = {j for j in range(len(cands))
                       if combine(votes[j], rule)}
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
        print(f'{rule:9s} {npass:3d}/20  recall {zhit}/{ztot}  traps {ntrap}  fp {nfp}  '
              f'{" ".join(fails)}')


if __name__ == '__main__':
    main()
