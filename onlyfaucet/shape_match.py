#!/usr/bin/env python3
"""Compare a shape (sprite silhouette) against blob shapes found in the bg.

Both are normalised (centroid removed, sqrt-area scale) then rasterised on a
common grid; the best IoU over rotations and reflections is reported.
"""
import sys, json, argparse
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('bg')
ap.add_argument('sprite')
ap.add_argument('--json', action='store_true')
ap.add_argument('--out', default=None)
args = ap.parse_args()


def contours_of(mask):
    mask = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    return [c for c in cnts if cv2.contourArea(c) > 300]


def norm_pts(c, N=192):
    M = cv2.moments(c)
    if M['m00'] <= 0:
        return None
    cx, cy = M['m10'] / M['m00'], M['m01'] / M['m00']
    p = c.astype(np.float64).reshape(-1, 2) - np.array([cx, cy])
    p /= np.sqrt(M['m00'])
    q = np.vstack([p, p[:1]])
    d = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(q, axis=0), axis=1))]
    if d[-1] <= 0:
        return None
    t = np.linspace(0, d[-1], N, endpoint=False)
    return np.stack([np.interp(t, d, q[:, 0]), np.interp(t, d, q[:, 1])], 1)


def raster(p, S=96, pad=1.5):
    lo = p.min(axis=0) - pad
    hi = p.max(axis=0) + pad
    span = max(hi - lo)
    ctr = (lo + hi) / 2
    q = (p - ctr) + span / 2
    q = (q / span * (S - 1))
    img = np.zeros((S, S), np.uint8)
    cv2.fillPoly(img, [q.round().astype(np.int32)], 1)
    return img


def best_iou(A, B, step=5):
    best = (0.0, 0, False)
    n = A.shape[0]
    for flip in (False, True):
        Bf = B.copy()
        if flip:
            Bf[:, 0] *= -1
        for k in range(0, 360, step):
            th = np.radians(k)
            R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
            rot = Bf @ R.T
            ra = raster(rot)
            inter = np.logical_and(ra, A).sum()
            union = np.logical_or(ra, A).sum()
            iou = inter / union if union else 0
            if iou > best[0]:
                best = (iou, k, flip)
    return best


sp = cv2.imread(args.sprite, cv2.IMREAD_UNCHANGED)
a = sp[:, :, 3]
ys, xs = np.nonzero(a > 40)
sil = (a[ys.min():ys.max() + 1, xs.min():xs.max() + 1] > 40).astype(np.uint8)
piece_c = contours_of(sil)
piece = norm_pts(max(piece_c, key=cv2.contourArea))
A = raster(piece)

bg = cv2.imread(args.bg)
shade_masks = []
for rgb in [(18, 27, 44), (20, 28, 46)]:
    B, G, R = rgb[2], rgb[1], rgb[0]
    d = np.abs(bg.astype(np.int16) - np.array([B, G, R])).sum(axis=2)
    shade_masks.append((rgb, (d <= 2).astype(np.uint8)))

results = []
for rgb, m in shade_masks:
    n, lbl, st, ce = cv2.connectedComponentsWithStats(m, 8)
    for i in range(1, n):
        x, y, w, h, area = st[i]
        if area < 400:
            continue
        sub = (lbl == i).astype(np.uint8)
        cs = contours_of(sub)
        if not cs:
            continue
        c = max(cs, key=cv2.contourArea)
        p = norm_pts(c)
        if p is None:
            continue
        iou, k, flip = best_iou(A, p)
        clipped = bool(x <= 1 or y <= 1 or x + w >= bg.shape[1] - 1 or y + h >= bg.shape[0] - 1)
        results.append({'shade': rgb, 'bbox': [int(x), int(y), int(w), int(h)],
                        'area': int(area), 'clipped': clipped,
                        'iou': round(float(iou), 3), 'rot': k, 'flip': flip,
                        'cent': [round(float(ce[i][0]), 1), round(float(ce[i][1]), 1)]})

results.sort(key=lambda r: -r['iou'])
out = {'pieceArea': int(sil.sum()), 'pieceBbox': [int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)],
       'blobs': results}
print(json.dumps(out, indent=1) if args.json else json.dumps(out))
