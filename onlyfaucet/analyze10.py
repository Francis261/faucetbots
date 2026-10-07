#!/usr/bin/env python3
"""analyze10.py — per-cell majority within signals (3 samples each) feeding
safe-union.

Samples: E (run_all) + E_b/E_c (rep); E2 (div, seed7) + E2_b/E2_c (rep);
P2 (div) + P2_b/P2_c (rep).  B stays single (stable across runs).

Signal accept-set := cell where >=2/3 samples accept (all-S / equal-slots
rules as in the single-sample readers).
"""
import json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from eval_cv5 import SHOTS
from analyze import cell_sets, dedupe_taps, strict
from analyze5 import vB, vE, vP
from analyze8 import vE2, vP2, RA, PR, R

DIV = json.load(open(SHOTS / 'div.json'))
REP = json.load(open(SHOTS / 'rep.json'))


def _cell_e(sample, j):
    """sample: dict of cell -> raw E-style string (keys 0-based after norm)."""
    s = sample.get(str(j))
    if isinstance(s, str):
        s = s.replace(' ', '')
        if len(s) == 5 and set(s) == {'S'}:
            return True
    return False


def _cell_p(sample, j):
    s = sample.get(str(j))
    return s == 'SSSSS'


def _to0(cells):
    """run_all E keys are 1-based; everything else is already 0-based."""
    if cells is None:
        return None
    if not cells:
        return {}
    if all(k.isdigit() and int(k) >= 1 and str(int(k) - 1) not in cells
           for k in cells):
        # heuristic: consecutive from '1' -> 1-based
        ks = sorted(int(k) for k in cells if k.isdigit())
        if ks and ks[0] == 1:
            return {str(int(k) - 1): v for k, v in cells.items()}
    return cells


def _maj3_sets(samples, accept, n):
    """samples: list of per-cell dicts; returns accept-set with >=2/3 votes."""
    out = set()
    for j in range(n):
        votes = sum(1 for s in samples if s is not None and accept(s, j))
        if votes >= 2:
            out.add(j)
    return out


def signals(i, n):
    res = RA.get(str(i), {})
    div = DIV.get(str(i), {})
    rep = REP.get(str(i), {})
    b = vB(res.get('B'), n)

    e_cells = (res.get('E') or {}).get('cells')
    e_samples = [_to0(e_cells), rep.get('E_b'), rep.get('E_c')]
    e = _maj3_sets(e_samples, _cell_e, n)

    e2_samples = [div.get('E2'), rep.get('E2_b'), rep.get('E2_c')]
    e2 = _maj3_sets(e2_samples, _cell_e, n)

    p2_samples = [div.get('P2'), rep.get('P2_b'), rep.get('P2_c')]
    p2 = _maj3_sets(p2_samples, _cell_p, n)

    return {'B': b, 'E': e, 'E2': e2, 'P2': p2}


def safe_union(v, n):
    if any(v[k] is None for k in ('B', 'E', 'E2', 'P2')):
        return None
    a = {j for j in range(n) if sum(j in v[k] for k in ('B', 'E', 'P2')) >= 2}
    c = {j for j in range(n) if sum(j in v[k] for k in ('B', 'E2', 'P2')) >= 2}
    return a | c


def main():
    cell_list = [cell_sets(i) for i in range(len(R))]
    # single-sample reference for comparison
    def single_union(i, n):
        res = RA.get(str(i), {})
        div = DIV.get(str(i), {})
        v = {'B': vB(res.get('B'), n), 'E': vE(res.get('E'), n),
             'E2': vE2(i, n), 'P2': vP2(i, n)}
        if any(x is None for x in v.values()):
            return None
        a = {j for j in range(n) if sum(j in v[k] for k in ('B', 'E', 'P2')) >= 2}
        c = {j for j in range(n) if sum(j in v[k] for k in ('B', 'E2', 'P2')) >= 2}
        return a | c

    for label, fn in (('single-sample', single_union),
                      ('3-sample-majority', lambda i, n: safe_union(signals(i, n), n))):
        npass = ntrap = nfp = zhit = ztot = 0
        fails = []
        for i in range(len(R)):
            cands, zc, tc, ex = cell_list[i]
            m = fn(i, len(cands))
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
        print(f'{label:20s} {npass}/20 recall {zhit}/{ztot} traps {ntrap} fp {nfp}'
              f'  {" ".join(fails)}')

    # also: per-signal stability report (how often single == majority set)
    print('\nper-signal set sizes (single vs majority):')
    for i in range(len(R)):
        n = len(cell_list[i][0])
        res = RA.get(str(i), {})
        div = DIV.get(str(i), {})
        rep = REP.get(str(i), {})
        e1 = vE(res.get('E'), n)
        em = _maj3_sets([_to0((res.get('E') or {}).get('cells')),
                         rep.get('E_b'), rep.get('E_c')], _cell_e, n)
        e21 = vE2(i, n)
        e2m = _maj3_sets([div.get('E2'), rep.get('E2_b'), rep.get('E2_c')],
                         _cell_e, n)
        p1 = vP2(i, n)
        pm = _maj3_sets([div.get('P2'), rep.get('P2_b'), rep.get('P2_c')],
                        _cell_p, n)
        print(f'ex{i:02d} E {sorted(e1 or [])}->{sorted(em)}  '
              f'E2 {sorted(e21 or [])}->{sorted(e2m)}  '
              f'P2 {sorted(p1 or [])}->{sorted(pm)}')


if __name__ == '__main__':
    main()
