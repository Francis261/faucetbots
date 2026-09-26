#!/usr/bin/env python3
"""Is one of the background's tone blobs congruent to the piece silhouette?

Search: uniform scale (0.6..2.5) x translation only — no rotation/flip, because
a hole cut for this piece must accept it in its drawn orientation.
"""
import sys, json, argparse
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('bg')
ap.add_argument('sprite')
ap.add_argument('--json', action='store_true')
args = ap.parse_args()

bg = cv2.imread(args.bg)
sp = cv2.imread(args.sprite, cv2.IMREAD_UNCHANGED)
a = sp[:, :, 3]
ys, xs = np.nonzero(a > 40)
sil = (a[ys.min():ys.max() + 1, xs.min():xs.max() + 1] > 40).astype(np.uint8)

# candidate regions = anything that is not the base shade and not a dash
base = np.array([22, 14, 38])  # B,G,R of (14,22,38)
d = np.abs(bg.astype(np.int16) - base).sum(axis=2)
notbase = (d > 2).astype(np.uint8)
# dashes are thin; tone blobs are thick -> open with a kernel wider than a dash
tone = cv2.morphologyEx(notbase, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
tone = cv2.morphologyEx(tone, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
n, lbl, st, ce = cv2.connectedComponentsWithStats(tone, 8)

out = []
for i in range(1, n):
    x, y, w, h, area = st[i]
    if area < 500:
        continue
    reg = (lbl == i).astype(np.uint8)
    best = (0.0, 1.0, None)
    for s in np.arange(0.6, 2.55, 0.05):
        tw, th = max(5, int(round(sil.shape[1] * s))), max(5, int(round(sil.shape[0] * s)))
        tpl = cv2.resize(sil, (tw, th), interpolation=cv2.INTER_NEAREST)
        tpl = (tpl > 0).astype(np.uint8)
        if tw > w or th > h:
            # still compare: use the region's bbox canvas
            pass
        m = cv2.matchTemplate(reg, tpl, cv2.TM_CCORR)
        _, mx, _, loc = cv2.minMaxLoc(m)
        inter = mx
        # union estimate: area(tpl) + area(region) - inter, restricted to bbox
        union = tpl.sum() + area - inter
        iou = inter / union if union else 0
        if iou > best[0]:
            best = (float(iou), float(s), (int(loc[0]), int(loc[1])))
    clipped = bool(x <= 1 or y <= 1 or x + w >= bg.shape[1] - 1 or y + h >= bg.shape[0] - 1)
    out.append({'bbox': [int(x), int(y), int(w), int(h)], 'area': int(area), 'clipped': clipped,
                'iou': round(best[0], 3), 'scale': round(best[1], 2), 'at': best[2],
                'cent': [round(float(ce[i][0]), 1), round(float(ce[i][1]), 1)]})

out.sort(key=lambda r: -r['iou'])
print(json.dumps({'pieceBbox': [int(sil.shape[1]), int(sil.shape[0])], 'regions': out},
                 indent=1) if args.json else json.dumps(out))
