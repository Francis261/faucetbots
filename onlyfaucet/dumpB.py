#!/usr/bin/env python3
"""dumpB.py — raw B-signal slot dumps for today's rounds (1 VLM call each).

Prints ref slots + per-cell 5-slot classification so ground truth can be
triangulated: B slots vs E/P2 votes (replay) vs visual inspection.
"""
import json, sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).parent))
import eval_cv5
from eval_cv5 import PROMPT as PROMPT_B, b64img, ref_crop, build_grid
import cand_v5
from v5solve import _ask, _valid_B

SHOTS = Path('/tmp/onlyfaucet-shots')
ROUNDS = [('A1', 1791533796749), ('A2', 1791534436691), ('A3', 1791535057182),
          ('A4', 1791536396705), ('A5', 1791537238064), ('A6', 1791539615061),
          ('R1', 1791535727909), ('R2', 1791537279757), ('R3', 1791538134062),
          ('R4', 1791539652917), ('R5', 1791540078616)]

out = {}
for rid, ts in ROUNDS:
    p = SHOTS / f'battery14-B-{rid}.json'
    if p.exists():
        out[rid] = json.load(open(p))
        print(rid, 'cached', flush=True)
        continue
    scene = cv2.imread(str(SHOTS / f'v5-scene-{ts}.png'))
    ref = cv2.imread(str(SHOTS / f'v5-ref-{ts}.png'))
    cands, _, _ = cand_v5.candidates(scene)
    parsed, raw, ms = _ask(PROMPT_B, [b64img(ref_crop(ref)),
                                      b64img(build_grid(scene, cands))],
                           max_tokens=2600, valid=_valid_B)
    json.dump(parsed, open(p, 'w'), indent=1)
    out[rid] = parsed
    print(rid, f'{ms}ms', flush=True)

for rid, _ in ROUNDS:
    d = out[rid]
    print(f"\n=== {rid} ref: {json.dumps(d.get('ref'))}")
    cells = d.get('cells') or {}
    for k in sorted(cells, key=lambda x: int(x)):
        print(f"  {k:>2}: {json.dumps(cells[k])}")
