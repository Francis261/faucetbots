#!/usr/bin/env python3
"""slotprobe.py — raw per-signal slot dump for one scene (diagnostics).

Runs the same four signals as the live safe-union rule (B, E x3, E2, P2) but
keeps the RAW strings, so we can see WHICH SLOT each veto came from.

  python3 slotprobe.py scene.png ref.png [truth_cells_csv]
"""
import sys, time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import cand_v5
from eval_cv5 import PROMPT, ref_crop, build_grid, b64img, norm_slots
from exp_v5 import PROMPT_E
from run_div import PROMPT_P2, build_grid_ord, pair_image2
import v5solve

SLOTS = ('body', 'wings', 'legs', 'head', 'tail')


def probe(scene_path, ref_path):
    scene = cv2.imread(scene_path)
    ref = cv2.imread(ref_path)
    cands, _, _ = cand_v5.candidates(scene)
    n = len(cands)
    out = {'n': n, 'cells': [[int(c['cx']), int(c['cy'])] for c in cands]}

    from concurrent.futures import ThreadPoolExecutor, as_completed
    with ThreadPoolExecutor(max_workers=4) as pool:
        futs = {}
        def sub(tag, *a, **kw):
            futs[tag] = pool.submit(v5solve._ask, *a, **kw)

        sub('B', PROMPT, [b64img(ref_crop(ref)), b64img(build_grid(scene, cands))],
            max_tokens=2600, valid=v5solve._valid_B)
        for k in range(3):
            sub(f'E{k}', PROMPT_E, [b64img(ref_crop(ref)), b64img(build_grid(scene, cands))],
                valid=lambda x: isinstance(x.get('cells'), dict))
        order = np.random.default_rng().permutation(n).tolist()
        sub('E2', PROMPT_E, [b64img(ref_crop(ref)), b64img(build_grid_ord(scene, cands, order))],
            valid=lambda x: isinstance(x.get('cells'), dict))
        for j in range(n):
            sub(f'P2_{j}', PROMPT_P2, [b64img(pair_image2(scene, cands, ref, j))],
                max_tokens=60, valid=lambda x: v5solve._slots5(x) is not None)

        res = {}
        for tag, fu in futs.items():      # all submitted already; collect
            try:                          # (parallel execution, ordered wait)
                res[tag] = fu.result()[0]
            except Exception as e:
                res[tag] = None
                print(f'  ! {tag}: {e}', file=sys.stderr)

    parsed = res['B']
    out['ref'] = norm_slots(parsed.get('ref')) if parsed else None
    bcells = {}
    cells = (parsed or {}).get('cells') or {}
    for j in range(n):
        bcells[j] = norm_slots(cells.get(str(j + 1), cells.get(j + 1)))
    out['B'] = bcells
    out['E'] = [{j: (((res[f'E{k}'] or {}).get('cells') or {}).get(str(j + 1)) or '?')
                 for j in range(n)} for k in range(3)]
    out['E2'] = {j: (((res['E2'] or {}).get('cells') or {}).get(str(j + 1)) or '?')
                 for j in range(n)}
    out['P2'] = {j: v5solve._slots5(res[f'P2_{j}']) for j in range(n)}
    return out


def report(out, truth=None):
    n = out['n']
    rs = out['ref'] or {}
    print(f"ref slots: {rs}")
    for j in range(n):
        b = out['B'][j]
        e = [out['E'][k][j] for k in range(3)]
        e2 = out['E2'][j]
        p2 = out['P2'][j]
        bstr = None if not isinstance(b, dict) else ''.join(
            'S' if b.get(s) == rs.get(s) else 'D' for s in SLOTS)
        yes = sum([
            bstr == 'SSSSS',
            sum(x == 'SSSSS' for x in e) >= 2,
            e2 == 'SSSSS',
            p2 == 'SSSSS',
        ])
        mark = ''
        if truth is not None:
            mark = ' TRUTH' if j in truth else (' FP?' if yes >= 2 else '')
        print(f"cell{j:2d} {mark:6s} B={bstr or 'X   '} E={e} E2={e2} P2={p2}  yes={yes}/4")


if __name__ == '__main__':
    scene, ref = sys.argv[1], sys.argv[2]
    truth = set(int(x) for x in sys.argv[3].split(',')) if len(sys.argv) > 3 else None
    t0 = time.time()
    r = probe(scene, ref)
    # raw dump FIRST: a report() bug must never throw away paid-for API data
    tag = Path(scene).stem.replace('v5-scene-', 'live-')
    dump = Path('/tmp/onlyfaucet-shots') / f'raw-{tag}.json'
    import json as _j
    dump.write_text(_j.dumps(r, default=str))
    report(r, truth)
    print(f'({time.time() - t0:.0f}s, n={r["n"]}) -> {dump}')
