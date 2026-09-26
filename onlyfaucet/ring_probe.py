#!/usr/bin/env python3
"""Where does the hole actually sit? Score edge/DoG maps with the piece silhouette.

Difference from score_holes.py: that script scored *texture* hypotheses (dash
density, tone). Here we look for the faint OUTLINE of the hole — the same
silhouette as the piece — in gradient maps, and report how prominent the global
peak is (z vs median/MAD) plus where the CV pick and the vision pick land in the
ranking. If one of them consistently sits at a high-z peak, it is the detector
we can trust; if neither does, the gate must keep refusing to submit.

Usage: ring_probe.py shot.png --cv x,y --vision x,y
"""
import sys, json, argparse
import cv2
import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('path')
ap.add_argument('--cv', default=None, help='x,y from find_hole.py')
ap.add_argument('--vision', default=None, help='x,y from analyzePuzzle')
args = ap.parse_args()

im = Image.open(args.path).convert('RGB')
W, H = im.size
a = np.asarray(im).astype(np.float32)
r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
gray = 0.299 * r + 0.587 * g + 0.114 * b

# ---- piece silhouette (blue outline blob, same rule as score_holes) --------
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
ring = cv2.dilate(solid, np.ones((5, 5), np.uint8)) - cv2.erode(solid, np.ones((5, 5), np.uint8))
core = cv2.erode(solid, np.ones((3, 3), np.uint8))
tmpls = {k: np.ascontiguousarray(v.astype(np.uint8)) for k, v in
         {'ring': ring, 'core': core, 'fill': solid}.items() if v.any()}

# ---- gradient-ish maps -----------------------------------------------------
g8 = gray.astype(np.uint8)
maps = {}
maps['canny1'] = cv2.Canny(g8, 40, 110).astype(np.float32)
maps['canny2'] = cv2.Canny(cv2.GaussianBlur(g8, (0, 0), 1.6), 30, 90).astype(np.float32)
for s in (1.0, 2.0, 4.0):
    dog = cv2.GaussianBlur(g8, (0, 0), s) - cv2.GaussianBlur(g8, (0, 0), s * 2.0)
    maps[f'dog{s}'] = np.abs(dog)
gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
maps['grad'] = cv2.magnitude(gx, gy)


def nz(x):
    return (x - x.mean()) / max(float(x.std()), 1e-6)


def parse_xy(s):
    if not s:
        return None
    x, y = s.split(',')
    return float(x), float(y)


pts = {'cv': parse_xy(args.cv), 'vision': parse_xy(args.vision)}
rows = []
for mname, M in maps.items():
    M = nz(M)
    for tname, T in tmpls.items():
        th, tw = T.shape
        if tw >= W or th >= H:
            continue
        for sign, tag in ((1.0, 'hi'), (-1.0, 'lo')):
            img = np.ascontiguousarray((sign * M).astype(np.float32))
            tpl = np.ascontiguousarray(T.astype(np.float32))
            sc = cv2.matchTemplate(img, tpl, cv2.TM_CCOEFF_NORMED)
            # blank out everything overlapping the (already-solved) piece
            sc[max(0, pb[1] - th):min(sc.shape[0], pb[1] + pb[3] + th),
               max(0, pb[0] - tw):min(sc.shape[1], pb[0] + pb[2] + tw)] = -2.0
            finite = sc[sc > -1.5]
            if finite.size < 10:
                continue
            med = float(np.median(finite))
            mad = float(np.median(np.abs(finite - med))) * 1.4826 + 1e-6
            flat = sc.ravel()
            order = np.argsort(flat)[::-1]
            peaks = []
            for j, idx in enumerate(order):
                if j > 200000 or len(peaks) >= 4:
                    break
                y, x = divmod(int(idx), sc.shape[1])
                px, py = x + tw / 2.0, y + th / 2.0
                if any((px - qx) ** 2 + (py - qy) ** 2 < (tw * 0.6) ** 2 for qx, qy in peaks):
                    continue
                peaks.append((px, py))
                if len(peaks) >= 4:
                    break
            row = {'map': mname, 'tmpl': tname, 'sign': tag,
                   'z': round((float(flat[order[0]]) - med) / mad, 1),
                   'peaks': [(round(px, 0), round(py, 0)) for px, py in peaks]}
            for k, p in pts.items():
                if p is None:
                    continue
                vals = []
                for qx, qy in peaks:
                    if (p[0] - qx) ** 2 + (p[1] - qy) ** 2 <= (tw * 0.6) ** 2:
                        yy = int(round(qy - th / 2.0))
                        xx = int(round(qx - tw / 2.0))
                        yy = min(max(yy, 0), sc.shape[0] - 1)
                        xx = min(max(xx, 0), sc.shape[1] - 1)
                        vals.append(round(float(sc[yy, xx]), 3))
                if vals:
                    row[k] = vals[0]
                    row[k + '_rank'] = next((i for i, pq in enumerate(peaks)
                                             if abs(pq[0] - p[0]) <= tw * 0.6
                                             and abs(pq[1] - p[1]) <= tw * 0.6), None)
            rows.append(row)

rows.sort(key=lambda d: -d['z'])
out = {'piece_box': pb, 'cv': pts['cv'], 'vision': pts['vision'], 'rows': rows}
print(json.dumps(out, indent=1))
