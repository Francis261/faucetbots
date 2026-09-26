#!/usr/bin/env python3
"""Hole detector probe: the hole renders as a DIM patch with the piece silhouette.

The piece (and therefore the hole it came from) shows dashes ~30-40% dimmer than
the surrounding board (observed: piece interior 78-81 vs board 110-130). This
script template-matches the piece silhouette against that dimness map and reports
how prominent the global peak is, plus where the CV pick and the vision pick fall.

Usage: dim_probe.py shot.png --cv x,y --vision x,y [--json]
"""
import sys, json, argparse
import cv2
import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('path')
ap.add_argument('--cv', default=None)
ap.add_argument('--vision', default=None)
ap.add_argument('--json', action='store_true')
args = ap.parse_args()

im = Image.open(args.path).convert('RGB')
W, H = im.size
a = np.asarray(im).astype(np.float32)
r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
gray = (0.299 * r + 0.587 * g + 0.114 * b).astype(np.float32)

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

# ---- dimness map: local dash brightness vs its wider neighbourhood ---------
bright = (gray > 60).astype(np.float32)
num = cv2.GaussianBlur(gray * bright, (0, 0), 6)
den = np.maximum(cv2.GaussianBlur(bright, (0, 0), 6), 1e-3)
db = num / den
wide = cv2.GaussianBlur(db, (0, 0), 20)
dim = (wide - db).astype(np.float32)          # positive = dimmer than context

# board texture variability (dashes are sparse: normalise by local dash amount)
dens = cv2.GaussianBlur(bright, (0, 0), 10)
dim_n = dim * np.clip(dens / max(float(dens.mean()), 1e-3), 0.25, 2.0)


def blank(sc, tw, th):
    """Mask out the (already solved) piece and the board border."""
    sc[max(0, pb[1] - th):min(sc.shape[0], pb[1] + pb[3] + th),
       max(0, pb[0] - tw):min(sc.shape[1], pb[0] + pb[2] + tw)] = -1e9
    sc[:5, :] = -1e9
    sc[-5:, :] = -1e9
    sc[:, :5] = -1e9
    sc[:, -5:] = -1e9
    return sc


def peaks_of(sc, tw, th, k=6):
    sc = sc.copy()
    blank(sc, tw, th)
    out = []
    flat = sc.ravel()
    order = np.argsort(flat)[::-1]
    for j, idx in enumerate(order):
        if j > 400000 or len(out) >= k:
            break
        y, x = divmod(int(idx), sc.shape[1])
        if flat[idx] <= -1e8:
            break
        px, py = x + tw / 2.0, y + th / 2.0
        if any((px - qx) ** 2 + (py - qy) ** 2 < (tw * 0.75) ** 2 for qx, qy, _ in out):
            continue
        out.append((px, py, float(flat[idx])))
    return out


def run(M, T, sign=1.0, tag=''):
    th, tw = T.shape
    if tw >= W or th >= H:
        return None
    img = np.ascontiguousarray((sign * M).astype(np.float32))
    tpl = np.ascontiguousarray(T.astype(np.float32))
    sc = cv2.matchTemplate(img, tpl, cv2.TM_CCOEFF_NORMED)
    sc = blank(sc, tw, th)
    pk = peaks_of(sc, tw, th)
    if not pk:
        return None
    vals = sc[sc > -1e8]
    med = float(np.median(vals))
    mad = float(np.median(np.abs(vals - med))) * 1.4826 + 1e-6
    return {'tag': tag, 'z': round((pk[0][2] - med) / mad, 1),
            'score': round(pk[0][2], 3),
            'peaks': [(round(p[0]), round(p[1]), round(p[2], 3)) for p in pk],
            'shape': (tw, th)}


rows = []
for sname, S in (('fill', solid),
                 ('ring', np.ascontiguousarray((cv2.dilate(solid, np.ones((5, 5), np.uint8))
                                                 - cv2.erode(solid, np.ones((5, 5), np.uint8))).astype(np.uint8)))):
    if not S.any():
        continue
    for mname, M in (('dim', dim), ('dimn', dim_n)):
        for sign, stag in ((1.0, 'hi'), (-1.0, 'lo')):
            rr = run(M, S, sign, f'{mname}_{sname}_{stag}')
            if rr:
                rows.append(rr)
rows.sort(key=lambda d: -d['z'])


def parse(s):
    if not s:
        return None
    x, y = s.split(',')
    return float(x), float(y)


pts = {'cv': parse(args.cv), 'vision': parse(args.vision)}
report = {'piece_box': pb, 'pts': pts, 'rows': []}
for row in rows:
    item = dict(row)
    for k, p in pts.items():
        if p is None:
            continue
        tw, th = row['shape']
        hit = [pk for pk in row['peaks']
               if abs(pk[0] - p[0]) <= tw * 0.75 and abs(pk[1] - p[1]) <= th * 0.75]
        item[k] = round(hit[0][2], 3) if hit else None
        item[k + '_rank'] = row['peaks'].index(hit[0]) if hit else None
    report['rows'].append(item)

if args.json:
    print(json.dumps(report, indent=1))
else:
    print('piece', pb, pts)
    for row in report['rows']:
        print(f"  z={row['z']:>6} {row['tag']:<16} peak={row['peaks'][0][:2]} "
              f"cv={row.get('cv')}@{row.get('cv_rank')} vis={row.get('vision')}@{row.get('vision_rank')}")
