#!/usr/bin/env python3
"""Run slotprobe over the official miss examples + live rejects -> file."""
import json, math, subprocess, sys
from pathlib import Path

sys.path.insert(0, '/home/francis/adbch/onlyfaucet')
from eval_mctut import R, MC, OUT

OUTF = Path('/tmp/onlyfaucet-shots/slotprobe-out.txt')
data = json.load(open(OUT))
# (example, cells missed by safe-union run1); mc05 is the FP case
misses = {1: [6], 5: [3], 6: [5], 8: [9], 10: [6], 15: [1, 3], 17: [6], 18: [5]}
LIVE = [('rej1', '1791553170396'), ('rej2', '1791553244959'),
        ('rej3', '1791553481673'), ('rej4', '1791553547714')]

lines = []
for i, mcells in sorted(misses.items()):
    ex = R[i]
    cells = data[str(i)]['cells']
    truth = set()
    for z in ex['zones']:
        truth.update(k for k, c in enumerate(cells)
                     if math.hypot(c[0] - z[0], c[1] - z[1]) <= z[2])
    scene = str(MC / f'mc{i:02d}-scene.png')
    ref = str(MC / f'mc{i:02d}-ref.png')
    lines.append(f'===== mc{i:02d}  MISS cells={mcells}  truth={sorted(truth)}'
                 f'  trap={ex.get("trap")}')
    print(f'probing mc{i:02d} ...', flush=True)
    p = subprocess.run(['python3', '/home/francis/adbch/onlyfaucet/slotprobe.py',
                        scene, ref, ','.join(map(str, sorted(truth)))],
                       capture_output=True, text=True, timeout=900)
    lines.append(p.stdout)
    if p.stderr.strip():
        lines.append('STDERR: ' + p.stderr.strip()[-400:])
    OUTF.write_text('\n'.join(lines))

for name, sid in LIVE:
    scene = f'/tmp/onlyfaucet-shots/v5-scene-{sid}.png'
    ref = f'/tmp/onlyfaucet-shots/v5-ref-{sid}.png'
    lines.append(f'===== {name} (live reject {sid})')
    print(f'probing {name} ...', flush=True)
    p = subprocess.run(['python3', '/home/francis/adbch/onlyfaucet/slotprobe.py',
                        scene, ref], capture_output=True, text=True, timeout=900)
    lines.append(p.stdout)
    if p.stderr.strip():
        lines.append('STDERR: ' + p.stderr.strip()[-400:])
    OUTF.write_text('\n'.join(lines))
print('done ->', OUTF)
