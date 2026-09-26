#!/usr/bin/env python3
"""Third detector: the hole's faint OUTLINE, found by recurring edge peaks.

Runs several edge/DoG maps x {ring,fill} templates, collects each map's top
peaks, then clusters them. A real hole outline shows up in *many* maps at the
same place; single-map artifacts (board border, swirl density) do not repeat.

Output (JSON): {"pieceBox":[x,y,w,h], "clusters":[{"x":..,"y":..,"w":weight,
"z":..,"peers":[[x,y],...]}], "pieces": [ ... ]} — clusters sorted by weight.

Usage: find_ring.py shot.png
"""
import sys, json
import cv2
import numpy as np
from PIL import Image

path = sys.argv[1]
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
solid = np.ascontiguousarray(solid_full[y0:y1, x0:x1].astype(np.uint8))
ring = np.ascontiguousarray(
    (cv2.dilate(solid, np.ones((5, 5), np.uint8)) - cv2.erode(solid, np.ones((5, 5), np.uint8))).astype(np.uint8))
tmpls = {k: v for k, v in {'ring': ring, 'fill': solid}.items() if v.any()}

# ---- maps ------------------------------------------------------------------
g8 = gray.astype(np.uint8)
maps = {
    'canny1': cv2.Canny(g8, 40, 110).astype(np.float32),
    'canny2': cv2.Canny(cv2.GaussianBlur(g8, (0, 0), 1.6), 30, 90).astype(np.float32),
    'canny3': cv2.Canny(cv2.GaussianBlur(g8, (0, 0), 2.4), 25, 80).astype(np.float32),
}
for s in (1.0, 2.0, 4.0):
    maps[f'dog{s}'] = np.abs(cv2.GaussianBlur(g8, (0, 0), s) - cv2.GaussianBlur(g8, (0, 0), s * 2.0))
gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
maps['grad'] = cv2.magnitude(gx, gy)

BORDER = 22


def nz(x):
    return (x - x.mean()) / max(float(x.std()), 1e-6)


peaks = []   # (x, y, z, tag)
for mname, M in maps.items():
    M = nz(M)
    for tname, T in tmpls.items():
        th, tw = T.shape
        if tw >= W or th >= H:
            continue
        for sign, stag in ((1.0, 'hi'), (-1.0, 'lo')):
            img = np.ascontiguousarray((sign * M).astype(np.float32))
            tpl = np.ascontiguousarray(T.astype(np.float32))
            sc = cv2.matchTemplate(img, tpl, cv2.TM_CCOEFF_NORMED)
            sc[max(0, pb[1] - th):min(sc.shape[0], pb[1] + pb[3] + th),
               max(0, pb[0] - tw):min(sc.shape[1], pb[0] + pb[2] + tw)] = -1e9
            sc[:BORDER, :] = -1e9
            sc[-BORDER:, :] = -1e9
            sc[:, :BORDER] = -1e9
            sc[:, -BORDER:] = -1e9
            vals = sc[sc > -1e8]
            if vals.size < 10:
                continue
            med = float(np.median(vals))
            mad = float(np.median(np.abs(vals - med))) * 1.4826 + 1e-6
            flat = sc.ravel()
            order = np.argsort(flat)[::-1]
            got = 0
            combo_peaks = []
            for j, idx in enumerate(order):
                if j > 300000 or got >= 4:
                    break
                if flat[idx] <= -1e8:
                    break
                y, x = divmod(int(idx), sc.shape[1])
                px, py = x + tw / 2.0, y + th / 2.0
                if any((px - qx) ** 2 + (py - qy) ** 2 < 26 ** 2 for qx, qy in combo_peaks):
                    continue          # one peak per spot inside a single map
                combo_peaks.append((px, py))
                z = (float(flat[idx]) - med) / mad
                peaks.append((px, py, z, f'{mname}_{tname}_{stag}'))
                got += 1

# ---- cluster recurring peaks ------------------------------------------------
CLUSTER_R = 30.0
clusters = []
for px, py, z, tag in peaks:
    mname = tag.split('_')[0]
    tname = tag.split('_')[1]
    placed = False
    for c in clusters:
        if (px - c['x']) ** 2 + (py - c['y']) ** 2 <= CLUSTER_R ** 2:
            c['peers'].append((px, py, z, tag))
            c['maps'].add(mname)
            c['tmpls'].add(tname)
            wsum = sum(max(p[2], 0.1) for p in c['peers'])
            c['x'] = sum(p[0] * max(p[2], 0.1) for p in c['peers']) / wsum
            c['y'] = sum(p[1] * max(p[2], 0.1) for p in c['peers']) / wsum
            c['z'] = max(c['z'], z)
            c['w'] = len(c['peers'])
            placed = True
            break
    if not placed:
        clusters.append({'x': px, 'y': py, 'z': z, 'w': 1,
                         'maps': {mname}, 'tmpls': {tname},
                         'peers': [(px, py, z, tag)]})

clusters.sort(key=lambda c: (-len(c['maps']), -c['w'], -c['z']))
out = {
    'pieceBox': list(pb),
    'clusters': [{
        'x': round(c['x'], 1), 'y': round(c['y'], 1),
        'w': c['w'], 'z': round(c['z'], 1),
        'maps': sorted(c['maps']),
        'nMaps': len(c['maps']),
        'peers': [[round(p[0]), round(p[1])] for p in c['peers'][:12]],
    } for c in clusters[:8]],
}
print(json.dumps(out))
