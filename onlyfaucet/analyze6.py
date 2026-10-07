#!/usr/bin/env python3
"""analyze6.py — does voter agreement predict strict-pass?

For maj3(B,E,P): per example, cell verdicts are 3/3 (unanimous), 2/3 or 1/3.
Report pass rate by agreement level; test a confidence gate (only 'solve'
examples where every cell is unanimous).
"""
import json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from eval_cv5 import SHOTS
from analyze import cell_sets, dedupe_taps, strict
from analyze5 import vB, vE, vP

RA = json.load(open(SHOTS / 'run_all.json'))
PR = json.load(open(SHOTS / 'pair.json'))
R = json.load(open(SHOTS / 'tutorial20.json'))


def main():
    cell_list = [cell_sets(i) for i in range(len(R))]
    unanimous_pass = unanimous_all = split_pass = split_all = 0
    rows = []
    for i in range(len(R)):
        cands, zc, tc, ex = cell_list[i]
        n = len(cands)
        b = vB(RA.get(str(i), {}).get('B'), n)
        e = vE(RA.get(str(i), {}).get('E'), n)
        p = vP(PR.get(str(i), {}), n)
        if None in (b, e, p):
            rows.append((i, 'nodata', None, None))
            continue
        votes = {j: sum(j in s for s in (b, e, p)) for j in range(n)}
        maj = {j for j, v in votes.items() if v >= 2}
        kept = dedupe_taps(maj, cands)
        ok, hits, trap, fp = strict(kept, ex)
        all_unan = all(v in (0, 3) for v in votes.values())
        n_split = sum(1 for v in votes.values() if v in (1, 2))
        if all_unan:
            unanimous_all += 1
            unanimous_pass += ok
        else:
            split_all += 1
            split_pass += ok
        rows.append((i, 'PASS' if ok else f'FAIL {hits}/{len(ex["zones"])}'
                     + ('T' if trap else '') + ('F' if fp else ''),
                     'unanimous' if all_unan else f'{n_split} split',
                     votes))
    for i, res, agree, votes in rows:
        print(f'ex{i:02d} {res:14s} {agree}')
    print(f'\nunanimous examples: {unanimous_pass}/{unanimous_all} pass')
    print(f'split examples:     {split_pass}/{split_all} pass')


if __name__ == '__main__':
    main()
