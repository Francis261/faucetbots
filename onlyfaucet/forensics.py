#!/usr/bin/env python3
"""forensics.py — labeled live-captcha test set + gate scorer.

TRUTH below was established 2026-10-13 by zoomed visual inspection of the
saved live scenes (see /tmp/onlyfaucet-shots/forensic/*.png) plus, for size,
by site-verify inference (claims = truth; a failed proposal whose smallest
pick was visibly correct pins the biggest pick as wrong).

  python3 forensics.py [replay.json]     # score candidate gates vs labels

A gate PROPOSES a set: correct set = claim (site-verified), wrong set =
WRONG-VERIFY (blocks the account ~20min), None = safe free retry (bail).
Precision matters far more than coverage.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from v7solve import V7_RULES, N_BLOCKS  # noqa: E402

# round index -> verified truth (0-based block ids)
TRUTH = {
    1:  [3, 5],    # 2-eyes CLAIM (site-verified)
    3:  [2, 5],    # size WRONG  (visual: smallest #3, biggest #6)
    5:  [2, 3],    # arms-wings WRONG (visual: #4 sticks+hands, #3 stumps;
                   #   #8's pink nubs = lower butterfly wings, #6 bare)
    6:  [1, 5],    # size CLAIM
    7:  [0, 3],    # arms-wings WRONG (visual: #1,#4 arms+wings; #2,#8 no arms)
    8:  [0, 6],    # stripes CLAIM
    10: [3, 4],    # size: model+pixels unanimously {4,5}; the site-verify fail
                   #   was POSITIONAL — bbox-center tap on tiny blk4 sat 19px
                   #   off its body centroid (outside the answer circle).
    15: [3, 5],    # arms-wings CLAIM
    16: [2, 6],    # side CLAIM
    18: [5, 6],    # body CLAIM
    19: [1, 6],    # twins WRONG (visual: ref = bunny ears+wings+arms+no legs
                   #   -> #2,#7)
    21: [1, 7],    # size CLAIM
    24: [3, 7],    # side CLAIM
    27: [1, 2],    # twins WRONG (visual: ref = sprout+arms+no wings+no legs
                   #   -> #2,#3; #8 has no sprout)
    29: [2, 5],    # 2-eyes (visual: exactly #3,#6 have 2 eyes; #1,#2,#7 have
                   #   3, #4,#5,#8 have 1)
}

# per-task candidate gates to score (mirrors eval CANDS7 + live-only kinds)
CANDS = {
    'twins':            ['B7-exact2', 'V-exact2', 'BV-agree', 'BV-subset'],
    'biggest-smallest': ['G-inter-exact2', 'GS-equal', 'S2', 'G0', 'G1'],
    'arms-wings':       ['G-inter-exact2', 'maj2GB-exact2', 'B7-exact2',
                         'GEBeq', 'GB-agree', 'GEC-equal', 'GC-contain',
                         'C-exact2'],
    '2-eyes':           ['G-inter-exact2', 'GEC-equal', 'C-exact2',
                         'GC-contain'],
    'stripes':          ['C-inter-exact2'],
    'side':             ['G-inter-exact2'],
    'body-shape':       ['G-inter-exact2'],
}


def _v(run, k):
    s = run.get(k)
    return None if s is None else set(s)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else \
        '/tmp/onlyfaucet-shots/forensic/replay.json'
    rounds = json.load(open(path))
    stats = {}   # rule -> [claims, wrongs, bails]
    print(f"{'#':>2} {'kind':17s} {'truth':10s} {'gate outcomes (rule=pos WRONG?* bails)'}")
    for r in rounds:
        i = r['i']
        kind = r.get('kind')
        if i not in TRUTH or kind not in CANDS:
            continue
        t = set(TRUTH[i])
        v = {k: _v(r.get('verdict') or {}, k)
             for k in ('G0', 'G1', 'B7', 'V', 'S2', 'C', 'C2')}
        bits = []
        for rule in CANDS[kind]:
            fn, _ = V7_RULES[rule]
            try:
                m = fn(v, N_BLOCKS)
            except Exception:
                m = None
            st = stats.setdefault(rule, [0, 0, 0])
            if m is None:
                st[2] += 1
                continue
            m = set(m)
            if m == t and len(m) == 2:
                st[0] += 1
                bits.append(f'{rule}=CLAIM')
            else:
                st[1] += 1
                bits.append(f'{rule}=WRONG{sorted(m)}')
        print(f"{i:2d} {kind:17s} {str(sorted(t)):10s} " + ' '.join(bits))
    print("\n=== gate summary over labeled live rounds ===")
    print(f"{'rule':18s} {'claims':>6s} {'WRONG':>5s} {'bails':>5s}")
    for rule, (ok, wrong, bail) in sorted(stats.items(),
                                           key=lambda x: (x[1][1], -x[1][0])):
        mark = ' <-- unsafe' if wrong else (' <-- usable' if ok else '')
        print(f"{rule:18s} {ok:6d} {wrong:5d} {bail:5d}{mark}")


if __name__ == '__main__':
    main()
