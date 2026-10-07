#!/usr/bin/env python3
"""analyze11.py — pooled-vote rules over B(single) + 3x E + 3x E2 + 3x P2.

Per cell features: b (0/1), e (0..3), e2 (0..3), p2 (0..3).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from eval_cv5 import SHOTS
from analyze import cell_sets, dedupe_taps, strict
from analyze5 import vB, vE, vP
from analyze8 import vE2, vP2, RA, PR, R
from analyze10 import _to0, _cell_e, _cell_p, REP, DIV


def feats(i, n):
    res = RA.get(str(i), {})
    b = vB(res.get('B'), n)
    e_sing = vE(res.get('E'), n)
    e2_sing = vE2(i, n)
    p2_sing = vP2(i, n)
    e_s = [_to0((res.get('E') or {}).get('cells')), REP[str(i)].get('E_b'),
           REP[str(i)].get('E_c')]
    e2_s = [DIV[str(i)].get('E2'), REP[str(i)].get('E2_b'),
            REP[str(i)].get('E2_c')]
    p2_s = [DIV[str(i)].get('P2'), REP[str(i)].get('P2_b'),
            REP[str(i)].get('P2_c')]
    f = {}
    for j in range(n):
        f[j] = {
            'b': int(j in b) if b is not None else None,
            'es': int(j in e_sing) if e_sing is not None else None,
            'e2s': int(j in e2_sing) if e2_sing is not None else None,
            'p2s': int(j in p2_sing) if p2_sing is not None else None,
            'e': sum(1 for s in e_s if s is not None and _cell_e(s, j)),
            'e2': sum(1 for s in e2_s if s is not None and _cell_e(s, j)),
            'p2': sum(1 for s in p2_s if s is not None and _cell_p(s, j)),
        }
    return f


def evaluate(name, fn, cell_list):
    npass = ntrap = nfp = zhit = ztot = 0
    fails = []
    for i in range(len(R)):
        cands, zc, tc, ex = cell_list[i]
        f = feats(i, len(cands))
        if any(v[k] is None for v in f.values() for k in ('b', 'es', 'e2s', 'p2s')):
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
    print(f'{name:34s} {npass:3d}/20 recall {zhit:2d}/{ztot} traps {ntrap} fp {nfp}'
          f'  {" ".join(fails)}')


def main():
    cell_list = [cell_sets(i) for i in range(len(R))]

    rules = {
        # emaj-gated variants: ex2's traps are B-stably-wrong and E rejects
        # them stably (3/3 samples) — requiring emaj blocks the B+partner-flip
        # trap path that keeps recurring in fresh runs.
        'W1 emaj AND (b OR p2s)': lambda v: v['e'] >= 2 and (v['b'] or v['p2s']),
        'W2 emaj AND (b OR p2s OR e2s)': lambda v: v['e'] >= 2 and (v['b'] or v['p2s'] or v['e2s']),
        'W3 (emaj AND (b OR p2s)) OR (b AND e2s AND p2s)': lambda v: (
            (v['e'] >= 2 and (v['b'] or v['p2s'])) or
            (v['b'] and v['e2s'] and v['p2s'])),
        'W4 emaj AND p2s': lambda v: v['e'] >= 2 and v['p2s'],
        'W5 (b AND emaj) OR (emaj AND p2s) OR (e2s AND p2s)': lambda v: (
            (v['b'] and v['e'] >= 2) or (v['e'] >= 2 and v['p2s']) or
            (v['e2s'] and v['p2s'])),
        'W6 (emaj AND p2s) OR (b AND emaj)': lambda v: (
            (v['e'] >= 2 and v['p2s']) or (v['b'] and v['e'] >= 2)),
        'V1 e2maj-only': lambda v: (
            (v['b'] + v['es'] + v['p2s'] >= 2) or
            (v['b'] + (v['e2'] >= 2) + v['p2s'] >= 2)),
        'V2 emaj-only': lambda v: (
            (v['b'] + (v['e'] >= 2) + v['p2s'] >= 2) or
            (v['b'] + v['e2s'] + v['p2s'] >= 2)),
        'V3 p2maj-only': lambda v: (
            (v['b'] + v['es'] + (v['p2'] >= 2) >= 2) or
            (v['b'] + v['e2s'] + (v['p2'] >= 2) >= 2)),
        'V6 no-B: 2of(emaj,e2maj,p2maj)': lambda v: (
            (v['e'] >= 2) + (v['e2'] >= 2) + (v['p2'] >= 2) >= 2),
        'pooled safe-union (2 of maj sigs)': lambda v: (
            (v['b'] + (v['e'] >= 2) + (v['p2'] >= 2) >= 2) or
            (v['b'] + (v['e2'] >= 2) + (v['p2'] >= 2) >= 2)),
        'maj4(b,emaj,e2maj,p2maj)@3': lambda v: (
            v['b'] + (v['e'] >= 2) + (v['e2'] >= 2) + (v['p2'] >= 2) >= 3),
        'maj4(...)@2': lambda v: (
            v['b'] + (v['e'] >= 2) + (v['e2'] >= 2) + (v['p2'] >= 2) >= 2),
        'raw pooled >=7/10': lambda v: v['b'] + v['e'] + v['e2'] + v['p2'] >= 7,
        'raw pooled >=6/10': lambda v: v['b'] + v['e'] + v['e2'] + v['p2'] >= 6,
        'raw pooled >=8/10': lambda v: v['b'] + v['e'] + v['e2'] + v['p2'] >= 8,
        'safe-union + p2>=2 in both': lambda v: (
            v['p2'] >= 2 and (
                (v['b'] + (v['e'] >= 2) + (v['p2'] >= 2) >= 2) or
                (v['b'] + (v['e2'] >= 2) + (v['p2'] >= 2) >= 2))),
        'safe-union + p2>=1': lambda v: (
            v['p2'] >= 1 and (
                (v['b'] + (v['e'] >= 2) + (v['p2'] >= 2) >= 2) or
                (v['b'] + (v['e2'] >= 2) + (v['p2'] >= 2) >= 2))),
        'maj-union + single-p2 agrees': None,
    }
    for name, fn in rules.items():
        if fn is None:
            continue
        evaluate(name, fn, cell_list)

    # combined: single-sample union AND pooled features cross-check
    def single_or_maj(name):
        def fn(v):
            return v['_single'] and v['_maj']
        return fn

    # compute single-union membership per cell as an extra feature
    def with_single(fn):
        def g(v):
            return fn(v)
        return g

    # manual: single safe-union computed from single samples
    def single_union_eval():
        npass = ntrap = nfp = zhit = ztot = 0
        fails = []
        for i in range(len(R)):
            cands, zc, tc, ex = cell_list[i]
            n = len(cands)
            res = RA.get(str(i), {})
            v = {'B': vB(res.get('B'), n), 'E': vE(res.get('E'), n),
                 'E2': vE2(i, n), 'P2': vP2(i, n)}
            if any(x is None for x in v.values()):
                fails.append(f'{i}:nodata')
                continue
            a = {j for j in range(n) if sum(j in v[k] for k in ('B', 'E', 'P2')) >= 2}
            c = {j for j in range(n) if sum(j in v[k] for k in ('B', 'E2', 'P2')) >= 2}
            m = a | c
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
        print(f'{"single safe-union (baseline)":34s} {npass:3d}/20 recall {zhit:2d}/{ztot}'
              f' traps {ntrap} fp {nfp}  {" ".join(fails)}')

    single_union_eval()


if __name__ == '__main__':
    main()
