#!/usr/bin/env python3
"""analyze7.py — combinations including Ps (silhouette pairwise, sil.json).

Reuses verdict readers from analyze5; adds Ps with P's cell format.
"""
import json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from eval_cv5 import SHOTS
from analyze import cell_sets, dedupe_taps, strict
from analyze5 import vB, vE, vP

RA = json.load(open(SHOTS / 'run_all.json'))
PR = json.load(open(SHOTS / 'pair.json'))
SIL = json.load(open(SHOTS / 'sil.json'))
R = json.load(open(SHOTS / 'tutorial20.json'))


def main():
    cell_list = [cell_sets(i) for i in range(len(R))]

    def votes(i, n):
        res = RA.get(str(i), {})
        return {
            'B': vB(res.get('B'), n),
            'E': vE(res.get('E'), n),
            'P': vP(PR.get(str(i), {}), n),
            'S': vP(SIL.get(str(i), {}), n),
        }

    def maj(vs, need, n):
        if any(v is None for v in vs):
            return None
        return {j for j in range(n) if sum(j in v for v in vs) >= need}

    rules = {}
    for k in ('B', 'E', 'P', 'S'):
        rules[k] = (lambda k: lambda v, n: v[k])(k)
    rules['maj3(B,E,P)'] = lambda v, n: maj([v['B'], v['E'], v['P']], 2, n)
    rules['maj3(E,P,S)'] = lambda v, n: maj([v['E'], v['P'], v['S']], 2, n)
    rules['maj3(B,P,S)'] = lambda v, n: maj([v['B'], v['P'], v['S']], 2, n)
    rules['maj3(B,E,S)'] = lambda v, n: maj([v['B'], v['E'], v['S']], 2, n)
    rules['maj4(B,E,P,S)@3'] = lambda v, n: maj([v['B'], v['E'], v['P'], v['S']], 3, n)
    rules['maj2of(B,E,P,S)@2'] = lambda v, n: maj([v['B'], v['E'], v['P'], v['S']], 2, n)
    rules['maj3(P,S,B)@2'] = lambda v, n: maj([v['P'], v['S'], v['B']], 2, n)
    rules['maj(P,S)'] = lambda v, n: maj([v['P'], v['S']], 2, n)
    rules['maj(P,S)@1'] = lambda v, n: maj([v['P'], v['S']], 1, n)
    # E&S only (drop B entirely)
    rules['maj(E,S)@1'] = lambda v, n: maj([v['E'], v['S']], 1, n)
    rules['maj(E,P,S)@3'] = lambda v, n: maj([v['E'], v['P'], v['S']], 3, n)
    rules['maj(B,E,P,S)@3=4/4'] = lambda v, n: maj([v['B'], v['E'], v['P'], v['S']], 4, n)

    for name, fn in rules.items():
        npass = zhit = ztot = ntrap = nfp = 0
        fails = []
        for i in range(len(R)):
            cands, zc, tc, ex = cell_list[i]
            n = len(cands)
            v = votes(i, n)
            m = fn(v, n)
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
        print(f'{name:20s} {npass:3d}/20 recall {zhit:2d}/{ztot}  traps {ntrap}  '
              f'fp {nfp}  {" ".join(fails)}')


if __name__ == '__main__':
    main()
