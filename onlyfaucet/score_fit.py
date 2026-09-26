#!/usr/bin/env python3
"""Independent sanity check for find_chain.py: does the piece silhouette's
boundary really trace a chain of dashes where we say the hole is?

For a given background + sprite + candidate centre we measure
    cover = |ring  AND  dilate(dash, k)| / |ring|
i.e. how much of the silhouette outline lies within k px of an actual dash.
A hole marker is a *closed chain* hugging the outline, so cover should be far
above the random-placement baseline for the true target and merely average for
decoys.

Usage: score_fit.py bg.png sprite.png x,y [x,y ...]
Prints each candidate's coverage plus its percentile against 400 random
placements of the same silhouette.
"""
import sys, json
import cv2
import numpy as np

img = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
sp = cv2.imread(sys.argv[2], cv2.IMREAD_UNCHANGED)
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
near = cv2.dilate(dash, np.ones((5, 5), np.uint8))   # dash within ~2px
h, w = ring.shape


def cover(cx, cy):
    x0, y0 = int(round(cx - w / 2)), int(round(cy - h / 2))
    x1, y1 = x0 + w, y0 + h
    if x0 < 0 or y0 < 0 or x1 > IW or y1 > IH:
        return None
    n = near[y0:y1, x0:x1]          # dash map under the silhouette outline
    tot = int(ring.sum())
    return float((ring & n).sum()) / tot if tot else None


rng = np.random.default_rng(7)
base = []
while len(base) < 400:
    v = cover(rng.uniform(w / 2, IW - w / 2), rng.uniform(h / 2, IH - h / 2))
    if v is not None:
        base.append(v)
base = np.array(base)
mu, sd = float(base.mean()), float(base.std()) + 1e-9

out = []
for spec in sys.argv[3:]:
    cx, cy = (float(v) for v in spec.split(','))
    v = cover(cx, cy)
    if v is None:
        out.append({'pt': spec, 'cover': None})
        continue
    out.append({
        'pt': spec, 'cover': round(v, 3),
        'z': round((v - mu) / sd, 2),
        'pct': round(float((base <= v).mean()) * 100, 1),
    })

print(json.dumps({'baseline_mu': round(mu, 3), 'baseline_sd': round(sd, 3),
                  'ring_px': int(ring.sum()), 'cands': out}, indent=1))
