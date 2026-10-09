#!/usr/bin/env python3
"""rulesearch6.py — exhaustive boolean-rule search on cached v6 battery verdicts.

Every cell's signal membership (B, E, E2, P2) is a 4-bit vector. Any
combination rule is a boolean function f: {0,1}^4 -> {0,1} (65536 total).
For each f: kept = cells with f(membership)=1 -> dedupe(20) -> strict
exact-set vs official zones. Reports the best rules by strict passes.

  python3 rulesearch6.py [battery.json]      # default battery-v6-mctut12.json
"""
import json, sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from eval_mctut6 import R, load, dedupe, strict_mc   # noqa: E402

SIGS = ('B', 'E', 'E2', 'P2')


def memberships(r, n):
    """{cell: 4-bit int} for runs where all four signals completed."""
    v = r.get('verdict') or {}
    if any(v.get(s) is None for s in SIGS):
        return None
    return [sum((j in set(v[s])) << k for k, s in enumerate(SIGS))
            for j in range(n)]


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / 'battery-v6-mctut12.json'
    data = json.load(open(path))
    runs = []          # (scene_idx, cands, memberships, ex)
    skipped = 0
    for i in range(len(R)):
        e = data.get(str(i))
        if not e:
            continue
        scene, ref, cands = load(i)
        for r in e['runs']:
            m = memberships(r, e['n'])
            if m is None:
                skipped += 1
                continue
            runs.append((i, cands, m, R[i]))
    print(f'{len(runs)} usable runs ({skipped} skipped: missing signals), '
          f'{len(set(i for i, *_ in runs))} scenes')
    if not runs:
        return

    results = []
    for f in range(1 << 16):
        npass = nhit = 0
        nfp = 0
        for i, cands, m, ex in runs:
            kept = dedupe([j for j in range(len(m)) if (f >> m[j]) & 1], cands)
            ok, hits, fp = strict_mc(kept, ex, cands)
            npass += ok
            nhit += hits
            nfp += fp
        results.append((npass, nhit, -nfp, f))
    results.sort(reverse=True)

    # name the standard rules for reference
    def mask_of(name):
        def g(b, e, e2, p2):
            if name == 'safe-union':
                a = sum(x for x in (b, e, p2)) >= 2
                c = sum(x for x in (b, e2, p2)) >= 2
                return a or c
            return False
        return g

    print(f'\n{"f":>6s} {"strict":>8s} {"hits":>8s} {"fp":>4s}   note')
    shown = set()
    for npass, nhit, nneg, f in results[:15]:
        print(f'{f:#06x} {npass:5d}/{len(runs)} {nhit:5d}/{2 * len(runs)} {-nneg:4d}')
        shown.add(f)
    # locate safe-union's function
    for f in range(1 << 16):
        ok = True
        for b in (0, 1):
            for e in (0, 1):
                for e2 in (0, 1):
                    for p2 in (0, 1):
                        su = (sum(x for x in (b, e, p2)) >= 2) or \
                             (sum(x for x in (b, e2, p2)) >= 2)
                        if bool((f >> (b | e << 1 | e2 << 2 | p2 << 3)) & 1) != su:
                            ok = False
                            break
                    if not ok: break
                if not ok: break
            if not ok: break
        if ok:
            rank = next((k for k, r in enumerate(results) if r[3] == f), None)
            r = results[rank]
            print(f'\nsafe-union = {f:#06x}: strict {r[0]}/{len(runs)} '
                  f'hits {r[1]}/{2 * len(runs)} fp {-r[2]} (rank {rank + 1})')
            break


if __name__ == '__main__':
    main()
