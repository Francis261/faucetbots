#!/usr/bin/env python3
"""run_all.py — run variants B (absolute), E (S/D matrix), F (pair rows) on all
20 tutorial examples at temp=0, dump raw results to /tmp/onlyfaucet-shots/run_all.json
for offline combination analysis. No scoring here.
"""
import json, sys, time
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).parent))
import cand_v5
from eval_cv5 import SHOTS, OUT, ref_crop, build_grid, b64img, norm_slots, SLOTS
from exp_v5 import (ask, PROMPT_E, PROMPT_F, build_pairs)
import exp_v5

OUT.mkdir(exist_ok=True)

# B = absolute classification of ref + cells in one call (eval_cv5 style) but temp=0
PROMPT_B = exp_v5.__dict__.get('PROMPT_B')


def main():
    R = json.load(open(SHOTS / 'tutorial20.json'))
    out_path = SHOTS / 'run_all.json'
    results = json.load(open(out_path)) if out_path.exists() else {}
    variants = sys.argv[1:] or ['B', 'E', 'F']
    for i, ex in enumerate(R):
        key = str(i)
        if key not in results:
            results[key] = {}
        scene = cv2.imread(str(SHOTS / f'tut{i:02d}-scene.png'))
        ref = cv2.imread(str(SHOTS / f'tut{i:02d}-ref.png'))
        cands, _, mode = cand_v5.candidates(scene)
        results[key]['n_cand'] = len(cands)
        results[key]['mode'] = mode
        for v in variants:
            if v in results[key].get('done', []):
                continue
            t0 = time.time()
            try:
                if v == 'B':
                    from eval_cv5 import PROMPT as PROMPT_EVAL
                    parsed, raw, ms = ask(PROMPT_EVAL, [b64img(ref_crop(ref)), b64img(build_grid(scene, cands))], max_tokens=2600)
                    if parsed:
                        ref_slots = norm_slots(parsed.get('ref'))
                        cells = parsed.get('cells') or {}
                        cell_slots = {str(j + 1): norm_slots(cells.get(str(j + 1)))
                                      for j in range(len(cands))}
                        results[key]['B'] = {'ref': ref_slots, 'cells': cell_slots, 'ms': ms}
                    else:
                        results[key]['B'] = {'error': raw[:200], 'ms': ms}
                elif v == 'E':
                    parsed, raw, ms = ask(PROMPT_E, [b64img(ref_crop(ref)), b64img(build_grid(scene, cands))])
                    results[key]['E'] = {'cells': (parsed or {}).get('cells'), 'ms': ms,
                                         'error': None if parsed else raw[:200]}
                elif v == 'F':
                    parsed, raw, ms = ask(PROMPT_F, [b64img(build_pairs(scene, cands, ref))], max_tokens=900)
                    results[key]['F'] = {'cells': (parsed or {}).get('cells'), 'ms': ms,
                                         'error': None if parsed else raw[:200]}
                results[key].setdefault('done', []).append(v)
                print(f'ex{i:02d} {v} done in {ms}ms')
            except Exception as e:
                print(f'ex{i:02d} {v} ERROR {e}')
            json.dump(results, open(out_path, 'w'), indent=1)
    print('saved', out_path)


if __name__ == '__main__':
    main()
