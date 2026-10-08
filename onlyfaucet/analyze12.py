#!/usr/bin/env python3
"""analyze12.py — battery for E-gated rules (live-faithful features).

Live rounds 2026-10-08 exposed two failure modes of safe-union (V2):
  r1036 (truth 3): B and E2 each had 2 extras; the OR-union let one in -> reject.
  r0945 (truth 2-3): P2 returned {} and B missed a truth cell; union kept 1 -> reject.
E (3-sample pooled majority) was correct or near-correct on BOTH rounds, and
E2-single agreed with E on every truth cell.  These rules gate on E:
  N1  e>=2 AND e2s
  N2  e>=2 AND (e2s OR b)
  N3  e>=2 AND (e2s OR p2s)
  N4  e>=2                      (E pooled solo — upper recall bound)
Features are LIVE-FAITHFUL: b (B single), e (E pooled maj over 3 samples),
e2s (E2 single), p2s (P2 single) — exactly what v5solve.py runs in production.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from analyze import cell_sets, dedupe_taps, strict
from analyze8 import RA, PR, R
from analyze10 import _to0, _cell_e, _cell_p, REP, DIV
from analyze5 import vB, vE
from analyze8 import vE2, vP2


def feats(i, n):
    res = RA.get(str(i), {})
    b = vB(res.get('B'), n)
    e_sing = vE(res.get('E'), n)
    e2_sing = vE2(i, n)
    p2_sing = vP2(i, n)
    e_s = [_to0((res.get('E') or {}).get('cells')), REP[str(i)].get('E_b'),
           REP[str(i)].get('E_c')]
    f = {}
    for j in range(n):
        f[j] = {
            'b': int(j in b) if b is not None else None,
            'e2s': int(j in e2_sing) if e2_sing is not None else None,
            'p2s': int(j in p2_sing) if p2_sing is not None else None,
            'e': sum(1 for s in e_s if s is not None and _cell_e(s, j)),
        }
    return f


def evaluate(name, fn, cell_list):
    npass = ntrap = nfp = zhit = ztot = 0
    fails = []
    for i in range(len(R)):
        cands, zc, tc, ex = cell_list[i]
        f = feats(i, len(cands))
        if any(v[k] is None for v in f.values() for k in ('b', 'e2s', 'p2s')):
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
    print(f'{name:38s} {npass:3d}/20 recall {zhit:2d}/{ztot} traps {ntrap} fp {nfp}'
          f'  {" ".join(fails)}')


def main():
    cell_list = [cell_sets(i) for i in range(len(R))]
    rules = {
        'V2 safe-union (baseline, LIVE)': lambda v: (
            (v['b'] + (v['e'] >= 2) + v['p2s'] >= 2) or
            (v['b'] + v['e2s'] + v['p2s'] >= 2)),
        'N1 E AND E2s': lambda v: v['e'] >= 2 and v['e2s'],
        'N2 E AND (E2s OR B)': lambda v: v['e'] >= 2 and (v['e2s'] or v['b']),
        'N3 E AND (E2s OR P2s)': lambda v: v['e'] >= 2 and (v['e2s'] or v['p2s']),
        'N4 E solo pooled': lambda v: v['e'] >= 2,
        'N5 (E AND E2s) OR (B AND P2s AND e>=1)': lambda v: (
            (v['e'] >= 2 and v['e2s']) or (v['b'] and v['p2s'] and v['e'] >= 1)),
        'N6 E AND E2s AND (B OR P2s)': lambda v: (
            v['e'] >= 2 and v['e2s'] and (v['b'] or v['p2s'])),
        'N7 (E AND E2s) OR safe-union': lambda v: (
            v['e'] >= 2 and v['e2s']) or (
            (v['b'] + (v['e'] >= 2) + v['p2s'] >= 2) or
            (v['b'] + v['e2s'] + v['p2s'] >= 2)),
    }
    for name, fn in rules.items():
        evaluate(name, fn, cell_list)


if __name__ == '__main__':
    main()
