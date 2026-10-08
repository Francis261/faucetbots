#!/usr/bin/env python3
"""analyze13.py — soft-vote battery for P2/E single-slot flakiness.

Live forensics 2026-10-08 (11:34 scene): P2 gives varied answers but never
SSSSS on today's creatures — one flippy slot (c1 SSSSD, c3 flipped between
runs) vetoes the whole P2 vote, so safe-union degenerates to B-gated combos
(misses when B misses, extras when E2 is sloppy).  Color-pairwise P found
SSSSS on the same cell.  On tut00 both signals are healthy (SSSSS present).

Tests (live-faithful: single DIV sample for E2/P2/P, pooled 3-sample for E):
  p2s4 / p2s3 : accept P2 vote when >=4 (or >=3) of 5 slots are S
  p2maj3*     : hypothetical 3-sample P2 in production (2of3 accept)
  p soft      : color-pairwise P with >=4 threshold / all-S
  E soft      : pooled E with >=4 threshold per sample
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from analyze import cell_sets, dedupe_taps, strict
from analyze8 import RA, PR, R, vE2, vP2
from analyze10 import _to0, REP, DIV
from analyze5 import vB, vE, vP


def sget(d, j):
    if not d:
        return None
    s = d.get(str(j))
    return s if isinstance(s, str) else None


def ge(s, k):
    if s is None:
        return 0
    s = s.replace(' ', '')
    return int(len(s) == 5 and s.count('S') >= k)


def feats(i, n):
    res = RA.get(str(i), {})
    b = vB(res.get('B'), n)
    e_s = [_to0((res.get('E') or {}).get('cells')), REP[str(i)].get('E_b'),
           REP[str(i)].get('E_c')]
    e2 = DIV[str(i)].get('E2')
    p2 = DIV[str(i)].get('P2')
    p2b, p2c = REP[str(i)].get('P2_b'), REP[str(i)].get('P2_c')
    pc = (PR.get(str(i), {}) or {}).get('cells') or {}
    f = {}
    for j in range(n):
        e_votes = sum(1 for s in e_s if s is not None and ge(sget(s, j), 5))
        e_votes4 = sum(1 for s in e_s if s is not None and ge(sget(s, j), 4))
        p2_votes = sum(ge(sget(s, j), 5) for s in (p2, p2b, p2c))
        p2_votes4 = sum(ge(sget(s, j), 4) for s in (p2, p2b, p2c))
        f[j] = {
            'b': int(j in b) if b is not None else None,
            'p': ge(sget(pc, j), 5) if pc else None,
            'p4': ge(sget(pc, j), 4) if pc else None,
            'e': e_votes,
            'e4': e_votes4,
            'e2s': ge(sget(e2, j), 5),
            'e2s4': ge(sget(e2, j), 4),
            'p2s': ge(sget(p2, j), 5),
            'p2s4': ge(sget(p2, j), 4),
            'p2s3': int((sget(p2, j) or '').replace(' ', '').count('S') >= 3
                        if sget(p2, j) else False),
            'p2maj': int(p2_votes >= 2),
            'p2maj4': int(p2_votes4 >= 2),
        }
    return f


def evaluate(name, fn, cell_list):
    npass = ntrap = nfp = zhit = ztot = 0
    fails = []
    for i in range(len(R)):
        cands, zc, tc, ex = cell_list[i]
        f = feats(i, len(cands))
        if any(v['b'] is None for v in f.values()):
            fails.append(f'{i}:nodata')
            continue
        m = {j for j, v in f.items() if fn(v)}
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
    print(f'{name:44s} {npass:3d}/20 recall {zhit:2d}/{ztot} traps {ntrap} fp {nfp}'
          f'  {" ".join(fails)}')


def main():
    cell_list = [cell_sets(i) for i in range(len(R))]

    def v2(p2key, ekey='e', e2key='e2s'):
        return lambda v: ((v['b'] + (v[ekey] >= 2) + v[p2key] >= 2) or
                          (v['b'] + v[e2key] + v[p2key] >= 2))

    rules = {
        'V2 baseline (p2s all-S)': v2('p2s'),
        'A1 V2 p2 >=4S': v2('p2s4'),
        'A2 V2 p2 >=3S': v2('p2s3'),
        'A3 V2 p2>=4S OR P all-S': lambda v: v2('p2s4')(v) or (v['p'] and (
            v['b'] + (v['e'] >= 2) >= 2 or v['b'] + v['e2s'] >= 2)),
        'A4 V2 p2 vote=(p2s4 OR p4)': v2('p2s4') if False else (
            lambda v: ((v['b'] + (v['e'] >= 2) + (v['p2s4'] or v['p4']) >= 2) or
                       (v['b'] + v['e2s'] + (v['p2s4'] or v['p4']) >= 2))),
        'A5 V2 p2>=4S AND e>=2 soft(e4)': (
            lambda v: ((v['b'] + (v['e4'] >= 2) + v['p2s4'] >= 2) or
                       (v['b'] + v['e2s4'] + v['p2s4'] >= 2))),
        'A6 V2 p2=3sample maj (all-S)': v2('p2maj'),
        'A7 V2 p2=3sample maj (>=4S)': v2('p2maj4'),
        'A8 asym: combo1 strict p2s, combo2 p2s4': (
            lambda v: ((v['b'] + (v['e'] >= 2) + v['p2s'] >= 2) or
                       (v['b'] + v['e2s'] + v['p2s4'] >= 2))),
        'A9 asym: combo1 p2s4, combo2 p2s': (
            lambda v: ((v['b'] + (v['e'] >= 2) + v['p2s4'] >= 2) or
                       (v['b'] + v['e2s'] + v['p2s'] >= 2))),
        'A10 V2 p2s4 OR (e>=2 AND p)': (
            lambda v: v2('p2s4')(v) or (v['e'] >= 2 and v['p'])),
        'A11 V2 p2s4, e2 soft4': v2('p2s4', e2key='e2s4'),
    }
    for name, fn in rules.items():
        evaluate(name, fn, cell_list)


if __name__ == '__main__':
    main()
