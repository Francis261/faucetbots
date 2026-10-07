#!/usr/bin/env python3
"""analyze9.py — derived rules: unions/intersections of zero-trap triples."""
import itertools, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from eval_cv5 import SHOTS
from analyze import cell_sets, dedupe_taps, strict
from analyze8 import vE2, vP2, RA, PR, R
from analyze5 import vB, vE, vP

cell_list = [cell_sets(i) for i in range(len(R))]


def votes(i, n):
    res = RA.get(str(i), {})
    return {'B': vB(res.get('B'), n), 'E': vE(res.get('E'), n),
            'P': vP(PR.get(str(i), {}), n), 'E2': vE2(i, n), 'P2': vP2(i, n)}


def maj3(v, ks, n):
    vs = [v[k] for k in ks]
    if any(x is None for x in vs):
        return None
    return {j for j in range(n) if sum(j in x for x in vs) >= 2}


def or_(*rules):
    def fn(v, n):
        parts = [r(v, n) for r in rules]
        if any(p is None for p in parts):
            return None
        return set().union(*parts)
    return fn


T = lambda *ks: (lambda v, n: maj3(v, ks, n))

rules = {
    'maj3(B,E,P2)': T('B', 'E', 'P2'),
    'maj3(B,E2,P2)': T('B', 'E2', 'P2'),
    'U(B,EP2,BE2P2)': or_(T('B', 'E', 'P2'), T('B', 'E2', 'P2')),
    'U(all 0T0F triples)': or_(T('B', 'E', 'P'), T('B', 'E', 'P2'),
                                T('B', 'E2', 'P'), T('B', 'P', 'P2'),
                                T('B', 'E2', 'P2'), T('E', 'P', 'P2'),
                                T('E2', 'P', 'P2'),
                                T('B', 'E', 'P', ), T('E', 'E2', 'P')),
    'U(B,EP2 + B,E2P2 + B,E,P)': or_(T('B', 'E', 'P2'), T('B', 'E2', 'P2'),
                                      T('B', 'E', 'P')),
    'I(B,EP2 ^ B,E2P2)': lambda v, n: (lambda a, b: None if None in (a, b) else a & b)(
        maj3(v, ('B', 'E', 'P2'), n), maj3(v, ('B', 'E2', 'P2'), n)),
    'maj4(B,E,E2,P2)@2': lambda v, n: (
        None if any(v[k] is None for k in ('B', 'E', 'E2', 'P2'))
        else {j for j in range(n)
              if sum(j in v[k] for k in ('B', 'E', 'E2', 'P2')) >= 2}),
    'maj4(B,E,P,P2)@2': lambda v, n: (
        None if any(v[k] is None for k in ('B', 'E', 'P', 'P2'))
        else {j for j in range(n)
              if sum(j in v[k] for k in ('B', 'E', 'P', 'P2')) >= 2}),
}

for name, fn in rules.items():
    npass = ntrap = nfp = 0
    fails = []
    for i in range(len(R)):
        cands, zc, tc, ex = cell_list[i]
        v = votes(i, len(cands))
        m = fn(v, len(cands))
        if m is None:
            fails.append(f'{i}:nodata')
            continue
        kept = dedupe_taps(m, cands)
        ok, hits, trap, fp = strict(kept, ex)
        npass += ok
        ntrap += trap
        nfp += fp
        if not ok:
            fails.append(f'{i}:{hits}/{len(ex["zones"])}'
                         f'{"T" if trap else ""}{"F" if fp else ""}')
    print(f'{name:26s} {npass:3d}/20 traps {ntrap} fp {nfp}  {" ".join(fails)}')
