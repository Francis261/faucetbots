#!/usr/bin/env python3
"""Score every plausible 'where is the hole' hypothesis for an OnlyFaucet puzzle.

For each hypothesis (anomaly map x sign x template shape) we slide the piece
silhouette over the map with a proper normalized correlation
(cv2.TM_CCOEFF_NORMED, so scores are comparable across maps) and report the
global peak *outside the piece*, plus how far above the score distribution it
sits (z-score) — prominence is what tells a real signal from noise.

Usage: score_holes.py shot.png [--json]
Writes: <shot>-score.png  (image annotated with each hypothesis' top peak)
"""
import sys, os, json, argparse
import cv2
import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('path')
ap.add_argument('--json', action='store_true')
args = ap.parse_args()
path = args.path

im = Image.open(path).convert('RGB')
W, H = im.size
a = np.asarray(im).astype(np.float32)
r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
gray = 0.299 * r + 0.587 * g + 0.114 * b

# ---- piece silhouette ------------------------------------------------------
blue = ((b > 140) & (b > r + 50) & (g > r + 20) & (g > 60)).astype(np.uint8)
blue[:5, :] = blue[-5:, :] = 0
blue[:, :5] = blue[:, -5:] = 0
n, lab, st, _ = cv2.connectedComponentsWithStats(blue, 8)
best, best_a = -1, -1
for i in range(1, n):
    area = int(st[i, cv2.CC_STAT_AREA])
    bw, bh = int(st[i, cv2.CC_STAT_WIDTH]), int(st[i, cv2.CC_STAT_HEIGHT])
    if area < 150 or bw < 25 or bh < 25 or bw > W * 0.7 or bh > H * 0.7:
        continue
    if area / max(bw * bh, 1) > 0.6:
        continue
    if area > best_a:
        best, best_a = i, area
if best < 0:
    print(json.dumps({'error': 'no piece found'}))
    sys.exit(1)
pm = (lab == best).astype(np.uint8)
filled = cv2.morphologyEx(pm, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
inv = 1 - filled
inv_p = cv2.copyMakeBorder(inv, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=1)
mf = np.zeros((inv_p.shape[0] + 2, inv_p.shape[1] + 2), np.uint8)
cv2.floodFill(inv_p, mf, (0, 0), 0)
solid_full = inv_p[1:-1, 1:-1].astype(np.uint8)
if solid_full.sum() < 30:
    solid_full = filled
cnts, _ = cv2.findContours(solid_full, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
pcnt = max(cnts, key=cv2.contourArea)
pb = cv2.boundingRect(pcnt)
pad = 4
x0, y0 = max(0, pb[0] - pad), max(0, pb[1] - pad)
x1, y1 = min(W, pb[0] + pb[2] + pad), min(H, pb[1] + pb[3] + pad)
solid = solid_full[y0:y1, x0:x1]

templates = {
    'fill': solid,
    'band': cv2.dilate(solid, np.ones((5, 5), np.uint8)) -
            cv2.erode(solid, np.ones((5, 5), np.uint8)),
    'ring': cv2.dilate(solid, np.ones((7, 7), np.uint8)) -
            cv2.erode(solid, np.ones((7, 7), np.uint8)),
}
templates = {k: np.ascontiguousarray(v.astype(np.uint8)) for k, v in templates.items() if v.any()}

# ---- anomaly maps ----------------------------------------------------------
white = ((gray > 70) & (r > 50) & (g > 50)).astype(np.float32)
blue_f = blue.astype(np.float32)
dash = white * (1 - blue_f)                      # dashes excluding the piece

def nz(x):
    return (x - x.mean()) / max(x.std(), 1e-6)

maps = {}
for s in (5, 9, 14, 22):
    d = cv2.GaussianBlur(dash, (0, 0), s)
    maps[f'dens{s}'] = nz(d - cv2.GaussianBlur(d, (0, 0), 2.2 * s))
light = cv2.GaussianBlur(gray, (0, 0), 2)
for s in (10, 18, 28):
    maps[f'tone{s}'] = nz(light - cv2.GaussianBlur(light, (0, 0), 2.2 * s))
# brightness of dashes only (hole dashes may be dimmer/brighter)
num = cv2.GaussianBlur(gray * dash, (0, 0), 5)
den = np.maximum(cv2.GaussianBlur(dash, (0, 0), 5), 1e-3)
maps['dashbright'] = nz(num / den)

# ---- score every combination ---------------------------------------------
out = []
score_maps = {}
for mname, M in maps.items():
    for tname, T in templates.items():
        th, tw = T.shape
        if tw >= W or th >= H:
            continue
        for sign, tag in ((1.0, 'hi'), (-1.0, 'lo')):
            img = np.ascontiguousarray((sign * M).astype(np.float32))
            tpl = np.ascontiguousarray(T.astype(np.float32))
            sc = cv2.matchTemplate(img, tpl, cv2.TM_CCOEFF_NORMED)
            # blank out windows overlapping the piece
            sc[max(0, pb[1] - th):min(sc.shape[0], pb[1] + pb[3] + th),
               max(0, pb[0] - tw):min(sc.shape[1], pb[0] + pb[2] + tw)] = -2.0
            finite = sc[sc > -1.5]
            if finite.size < 10:
                continue
            med = float(np.median(finite))
            mad = float(np.median(np.abs(finite - med))) * 1.4826 + 1e-6
            y, x = np.unravel_index(int(np.argmax(sc)), sc.shape)
            peak = float(sc[y, x])
            # 2nd best peak at least half a template away
            sc2 = sc.copy()
            sc2[max(0, y - th // 2):y + th // 2 + 1, max(0, x - tw // 2):x + tw // 2 + 1] = -2.0
            y2, x2 = np.unravel_index(int(np.argmax(sc2)), sc2.shape)
            second = float(sc2[y2, x2])
            out.append({
                'map': mname, 'tmpl': tname, 'sign': tag,
                'x': int(x + tw / 2), 'y': int(y + th / 2),
                'score': round(peak, 3),
                'z': round((peak - med) / mad, 1),
                'second': round(second, 3),
                'ratio': round(peak / max(second, 1e-3), 2),
                'w': int(tw), 'h': int(th),
            })
            score_maps[f'{mname}_{tname}_{tag}'] = (sc, tw, th)

out.sort(key=lambda d: (-d['z'], -d['score']))

if args.json:
    print(json.dumps(out, indent=1))
else:
    print(f'piece box={pb}')
    for row in out[:14]:
        print(f"  z={row['z']:>6} score={row['score']:>6} 2nd={row['second']:>6} "
              f"ratio={row['ratio']:>5}  ({row['x']},{row['y']}) {row['map']}/{row['tmpl']}/{row['sign']}")

# annotate top hypotheses
ov = cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR).copy()
palette = [(0, 255, 255), (0, 255, 0), (255, 0, 255), (0, 128, 255),
           (255, 255, 0), (255, 128, 0), (128, 255, 255), (255, 255, 255)]
for k, row in enumerate(out[:8]):
    col = palette[k % len(palette)]
    x, y, w, h = row['x'] - row['w'] // 2, row['y'] - row['h'] // 2, row['w'], row['h']
    cv2.rectangle(ov, (x, y), (x + w, y + h), col, 1)
    cv2.putText(ov, f"{k}:{row['z']}", (x + 2, max(11, y - 3)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, col, 1, cv2.LINE_AA)
cv2.rectangle(ov, (pb[0], pb[1]), (pb[0] + pb[2], pb[1] + pb[3]), (0, 200, 255), 2)
base = os.path.splitext(path)[0]
cv2.imwrite(f'{base}-score.png', ov)
json.dump(out, open(f'{base}-score.json', 'w'), indent=1)
print('wrote', f'{base}-score.png')
