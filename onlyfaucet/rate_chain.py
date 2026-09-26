#!/usr/bin/env python3
"""Run find_chain.py over the captured truth samples and print a compact table.

Usage: rate_chain.py T1 T2 ...
Expects <prefix>-bg.png / <prefix>-widget.png / <prefix>-sprite.png in
/tmp/onlyfaucet-shots plus a piece-geometry table.  Used to calibrate the
chain-gate thresholds on real (scaled, rendered) screenshots.
"""
import json, subprocess, sys, os

SHOTS = '/tmp/onlyfaucet-shots'
HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLE = {           # short name -> file prefix, piece centre in canvas coords
    'T1': ('truth', '81,211'),
    'T2': ('truth2', '58,120'),
    'T3': ('truth3', '57,125'),
    'T4': ('truth4', '59,68'),
    'T5': ('truth5', '71,82'),
}
RECT = '2,2,402,250'   # host box => canvas inset (border+padding)

for s in (sys.argv[1:] or ['T1', 'T2']):
    if s not in SAMPLE:
        print(f'{s}: unknown sample')
        continue
    pre, gm = SAMPLE[s]
    for label, img, rect in (
            ('bg    ', f'{SHOTS}/{pre}-bg.png', None),
            ('widget', f'{SHOTS}/{pre}-widget.png', RECT)):
        if not os.path.exists(img):
            print(f'{s} {label}: missing {img}')
            continue
        argv = ['python3', f'{HERE}/find_chain.py', img,
                '--sprite', f'{SHOTS}/{pre}-sprite.png', '--geom', gm, '--json']
        if rect:
            argv += ['--rect', rect]
        p = subprocess.run(argv, capture_output=True, text=True)
        try:
            d = json.loads(p.stdout)
        except Exception:
            print(f'{s} {label}: ERR {(p.stderr or p.stdout).strip()[:160]}')
            continue
        c = d.get('cands') or []
        print(f'{s} {label} target=({d.get("targetX")},{d.get("targetY")}) '
              f'z={d.get("z")} z2={d.get("z2")} margin={d.get("margin")} '
              f'pd={d.get("ptdist")} sup={d.get("support")} iou={d.get("iou0")} '
              f'piece=({d.get("pieceX")},{d.get("pieceY")}) n={len(c)}')
