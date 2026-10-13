#!/usr/bin/env python3
"""replay_live.py — run the CURRENT v7solve over saved live captcha rounds.

The live bot captured every challenge as v5-scene-<ts>.png + v5-ref-<ts>.png.
Rounds.json (from bot-loop.log) records title/sub/outcome and, for CLAIM rounds,
the verified-correct answer; for WRONG rounds the verified-WRONG proposal.

  python3 replay_live.py [out.json]

For each replayable round: solve() with the current gates -> verdict + proposed
set.  Scoring vs known labels happens in score_replay().
"""
import json
import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).parent))
from v7solve import solve, parse_task, FAMILY, TASK_SIGS  # noqa: E402

SHOTS = Path('/tmp/onlyfaucet-shots')
ROUNDS = SHOTS / 'forensic' / 'rounds.json'


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else str(SHOTS / 'forensic' / 'replay.json')
    rounds = json.load(open(ROUNDS))
    results = []
    for i, r in enumerate(rounds):
        ts, title, sub = r['ts'], r['title'], r['sub']
        scene_p = SHOTS / f'v5-scene-{ts}.png'
        ref_p = SHOTS / f'v5-ref-{ts}.png'
        rec = {'i': i, 'ts': ts, 'title': title, 'sub': sub,
               'old': r['outcome'], 'old_matched': r['solve'][1] if r['solve'] else None}
        if not scene_p.exists():
            rec['error'] = 'no scene'
            results.append(rec)
            print(f"{i:2d} {r['outcome']:9s} {title[:34]:36s} NO SCENE")
            continue
        scene = cv2.imread(str(scene_p))
        hint = cv2.imread(str(ref_p)) if ref_p.exists() else None
        try:
            kind = parse_task(title, sub)
            rec['kind'] = kind
            rec['family'] = FAMILY[kind]
            rec['sigs'] = list(TASK_SIGS[kind])
        except Exception as e:
            rec['kind'] = None
            rec['error'] = f'parse: {e}'
            results.append(rec)
            print(f"{i:2d} {r['outcome']:9s} {title[:34]:36s} parse-BAIL ({str(e)[:40]})")
            json.dump(results, open(out_path, 'w'), indent=1)
            continue
        try:
            out = solve(scene, hint, title, sub)
            rec['verdict'] = out['verdict']
            rec['matched'] = out['matched']
            rec['ok'] = out['ok']
            rec['rule'] = out['rule']
            rec['diag'] = {'B7ref': out['diag'].get('B7ref'),
                           'B7cells': out['diag'].get('B7cells')}
            rec['wall_ms'] = out.get('wall_ms')
        except Exception as e:
            rec['error'] = f'solve: {e}'
        results.append(rec)
        print(f"{i:2d} {r['outcome']:9s} {title[:34]:36s} "
              f"new={rec.get('matched')} rule={rec.get('rule')} old={rec.get('old_matched')}")
        json.dump(results, open(out_path, 'w'), indent=1)
    json.dump(results, open(out_path, 'w'), indent=1)
    print(f"\n{len(results)} rounds -> {out_path}")


if __name__ == '__main__':
    main()
