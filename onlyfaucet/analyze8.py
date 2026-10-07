#!/usr/bin/env python3
"""analyze8.py — combinations with E2 (shuffled grid) and P2 (swapped pair).

Goal: beat maj3(B,E,P) = 12/20 strict with 0 traps / 0 fp.
"""
import json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from eval_cv5 import SHOTS
from analyze import cell_sets, dedupe_taps, strict
from analyze5 import vB, vE, vP

RA = json.load(open(SHOTS / 'run_all.json'))
PR = json.load(open(SHOTS / 'pair.json'))
DIV = json.load(open(SHOTS / 'div.json'))
R = json.load(open(SHOTS / 'tutorial20.json'))


def vE2(i, n):
    res = DIV.get(str(i), {})
    cells = res.get('E2')
    if not cells:
        return None
    out = set()
    for j in range(n):
        s = cells.get(str(j))
        if isinstance(s, str):
            s = s.replace(' ', '')
            if len(s) == 5 and set(s) == {'S'}:
                out.add(j)
    return out


def vP2(i, n):
    res = DIV.get(str(i), {})
    cells = res.get('P2')
    if not cells:
        return None
    out = set()
    for j in range(n):
        s = cells.get(str(j))
        if isinstance(s, str) and s == 'SSSSS':
            out.add(j)
    return out


def main():
    cell_list = [cell_sets(i) for i in range(len(R))]

    def votes(i, n):
        res = RA.get(str(i), {})
        return {'B': vB(res.get('B'), n),
                'E': vE(res.get('E'), n),
                'P': vP(PR.get(str(i), {}), n),
                'E2': vE2(i, n),
                'P2': vP2(i, n)}

    def maj(vs, need, n):
        if any(v is None for v in vs):
            return None
        return {j for j in range(n) if sum(j in v for v in vs) >= need}

    K = lambda *ks: (lambda v, n: maj([v[k] for k in ks], max(2, len(ks) // 2 + 1), n))
    rules = {
        'E2': lambda v, n: v['E2'],
        'P2': lambda v, n: v['P2'],
        'maj3(B,E,P)': lambda v, n: maj([v['B'], v['E'], v['P']], 2, n),
        'maj3(E,P,P2)': lambda v, n: maj([v['E'], v['P'], v['P2']], 2, n),
        'maj3(B,P,P2)': lambda v, n: maj([v['B'], v['P'], v['P2']], 2, n),
        'maj3(B,E,E2)': lambda v, n: maj([v['B'], v['E'], v['E2']], 2, n),
        'maj3(B,E,P2)': lambda v, n: maj([v['B'], v['E'], v['P2']], 2, n),
        'maj3(E,P,E2)': lambda v, n: maj([v['E'], v['P'], v['E2']], 2, n),
        'maj3(E2,P,P2)': lambda v, n: maj([v['E2'], v['P'], v['P2']], 2, n),
        'maj4(B,E,P,P2)@3': lambda v, n: maj([v['B'], v['E'], v['P'], v['P2']], 3, n),
        'maj4(B,E,P,P2)@4': lambda v, n: maj([v['B'], v['E'], v['P'], v['P2']], 4, n),
        'maj4(E,E2,P,P2)@3': lambda v, n: maj([v['E'], v['E2'], v['P'], v['P2']], 3, n),
        'maj4(B,E,E2,P)@3': lambda v, n: maj([v['B'], v['E'], v['E2'], v['P']], 3, n),
        'maj5(B,E,E2,P,P2)@3': lambda v, n: maj([v['B'], v['E'], v['E2'],
                                                  v['P'], v['P2']], 3, n),
        'maj5(B,E,E2,P,P2)@4': lambda v, n: maj([v['B'], v['E'], v['E2'],
                                                  v['P'], v['P2']], 4, n),
        'maj5(B,E,E2,P,P2)@5': lambda v, n: maj([v['B'], v['E'], v['E2'],
                                                  v['P'], v['P2']], 5, n),
    }
    for name, fn in rules.items():
        npass = zhit = ztot = ntrap = nfp = 0
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
