#!/usr/bin/env python3
"""eval_e2e.py — end-to-end strict eval of v5solve.solve() on tutorial20.

Runs the EXACT runtime path (segment -> parallel VLM -> rule -> dedupe taps)
once per example, sequentially, and reports strict score + wall timing.
"""
import json, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import cv2
from eval_cv5 import SHOTS, score
from analyze import cell_sets, strict
from v5solve import solve, DEFAULT_RULE, RULES


def main():
    rule = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_RULE
    R = json.load(open(SHOTS / 'tutorial20.json'))
    cell_list = [cell_sets(i) for i in range(len(R))]
    npass = zhit = ztot = ntrap = nfp = 0
    fails = []
    walls = []
    for i in range(len(R)):
        scene = cv2.imread(str(SHOTS / f'tut{i:02d}-scene.png'))
        ref = cv2.imread(str(SHOTS / f'tut{i:02d}-ref.png'))
        t0 = time.time()
        res = solve(scene, ref, rule=rule)
        wall = time.time() - t0
        walls.append(wall)
        cands, zc, tc, ex = cell_list[i]
        if not res['ok']:
            fails.append(f'{i}:NODATA')
            print(f'ex{i:02d} solve failed: {res.get("reason")} ({wall:.1f}s)',
                  flush=True)
            continue
        # strict scoring from tap list -> rebuilt via kept candidate dicts
        from eval_cv5 import dedupe as _dedupe
        kept = _dedupe(set(res['matched']), cands)
        ok, hits, trap, fp = strict(kept, ex)
        npass += ok
        zhit += hits
        ztot += len(ex['zones'])
        ntrap += trap
        nfp += fp
        if not ok:
            fails.append(f'{i}:{hits}/{len(ex["zones"])}'
                         f'{"T" if trap else ""}{"F" if fp else ""}')
        print(f'ex{i:02d} {"PASS" if ok else "fail"} {hits}/{len(ex["zones"])}'
              f' taps={len(kept)} seg={res["seg_ms"]}ms vlm={res["vlm_ms"]}ms '
              f'wall={wall:.1f}s', flush=True)
    walls.sort()
    print(f'\n=== rule={rule}  {npass}/{len(R)} strict  recall {zhit}/{ztot}  '
          f'traps {ntrap}  fp {nfp}')
    print(f'wall: median {walls[len(walls)//2]:.1f}s  max {walls[-1]:.1f}s  '
          f'fails: {" ".join(fails)}')


if __name__ == '__main__':
    main()
