#!/usr/bin/env python3
"""Grid-scan a background for the best silhouette-outline / dash-chain matches.

Answers "is there a chain at all, and where?" independently of find_chain.py —
used to tell a missed detection from a sprite/bg mismatch.

Usage: scan_chain.py bg.png sprite.png [step]
Prints the top scoring positions by outline coverage.
"""
import sys, json
import cv2
import numpy as np

img = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
sp = cv2.imread(sys.argv[2], cv2.IMREAD_UNCHANGED)
step = int(sys.argv[3]) if len(sys.argv) > 3 else 5
if img is None or sp is None:
    print(json.dumps({'error': 'unreadable'}))
    sys.exit(1)
if img.ndim == 2:
    img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
IH, IW = img.shape[:2]

g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
med = cv2.medianBlur(g, 15 if min(IW, IH) > 200 else 9)
dash = ((g.astype(np.int16) - med.astype(np.int16)) > 12).astype(np.uint8)

a = sp[:, :, 3]
ys, xs = np.nonzero(a > 40)
s0 = (a[ys.min():ys.max() + 1, xs.min():xs.max() + 1] > 40).astype(np.uint8)
sil = s0 if (IH, IW) == (280, 450) else cv2.resize(
    s0, (max(3, round(s0.shape[1] * IW / 450)), max(3, round(s0.shape[0] * IH / 280))),
    interpolation=cv2.INTER_NEAREST)
sil = (sil > 0).astype(np.uint8)
ring = (cv2.dilate(sil, np.ones((5, 5), np.uint8)) -
        cv2.erode(sil, np.ones((5, 5), np.uint8))).astype(np.uint8)
near = cv2.dilate(dash, np.ones((5, 5), np.uint8))
h, w = ring.shape
tot = int(ring.sum())

scores = []
for cy in range(h // 2, IH - h // 2, step):
    y0 = cy - h // 2
    for cx in range(w // 2, IW - w // 2, step):
        x0 = cx - w // 2
        v = float((ring & near[y0:y0 + h, x0:x0 + w]).sum()) / tot
        scores.append((v, cx, cy))
scores.sort(reverse=True)

base = np.array([s[0] for s in scores])
mu, sd = float(base.mean()), float(base.std()) + 1e-9
top = [{'pt': f'{cx},{cy}', 'cover': round(v, 3),
        'z': round((v - mu) / sd, 2)} for v, cx, cy in scores[:8]]
print(json.dumps({'positions': len(scores), 'mu': round(mu, 3), 'sd': round(sd, 3),
                  'max': round(scores[0][0], 3), 'top': top}, indent=1))
