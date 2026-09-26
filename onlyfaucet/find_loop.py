#!/usr/bin/env python3
"""Find the hole: the closed chain of dashes in the background whose enclosed
shape is congruent to the piece silhouette.

1. dash mask = pixels that are not one of the flat background shades
2. blur so a chain of dashes becomes a continuous ridge, threshold, keep the
   components that actually close over an interior
3. compare each interior against the sprite silhouette (scale + rotation +
   reflection allowed) and rank by IoU

Usage: find_loop.py bg.png sprite.png [--json] [--out overlay.png]
"""
import sys, json, argparse
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('bg')
ap.add_argument('sprite')
ap.add_argument('--blur', type=float, default=5.0)
ap.add_argument('--thr', type=float, default=0.155)
ap.add_argument('--json', action='store_true')
ap.add_argument('--out', default=None)
args = ap.parse_args()

bg = cv2.imread(args.bg, cv2.IMREAD_UNCHANGED)
if bg is None:
    print(json.dumps({'error': 'unreadable'})); sys.exit(1)
if bg.ndim == 3 and bg.shape[2] == 4:
    bg = bg[:, :, :3]
H, W = bg.shape[:2]

sp = cv2.imread(args.sprite, cv2.IMREAD_UNCHANGED)
if sp is None or sp.ndim != 3 or sp.shape[2] < 4:
    print(json.dumps({'error': 'sprite unreadable'})); sys.exit(1)
a = sp[:, :, 3]
ys, xs = np.nonzero(a > 40)
if len(xs) < 50:
    print(json.dumps({'error': 'empty sprite'})); sys.exit(1)
sil = (a[ys.min():ys.max() + 1, xs.min():xs.max() + 1] > 40).astype(np.uint8)
sil = cv2.morphologyEx(sil, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))

# ---- 1. dash mask -------------------------------------------------------
# flat shades are the background; everything else is dash ink
flat = []
if bg.ndim == 3:
    q = (bg // 4).astype(np.int16)
    # the three navy shades live in one corner of the cube; take the darkest
    # 15% of pixels as "background"
    lum = bg.astype(np.float32) @ np.array([0.114, 0.587, 0.299])
    bgmask = lum < np.percentile(lum, 80)
    dash = (~bgmask).astype(np.float32)
else:
    dash = np.zeros((H, W), np.float32)

sm = cv2.GaussianBlur(dash, (0, 0), args.blur)

# ---- 2. closed chains ---------------------------------------------------
binm = (sm > args.thr).astype(np.uint8)
n, lbl, st, ce = cv2.connectedComponentsWithStats(binm, 8)
inv = (1 - binm).astype(np.uint8)
nh, hlbl, hst, hce = cv2.connectedComponentsWithStats(inv, 8)

cands = []
for i in range(1, nh):
    x, y, w, h, area = hst[i]
    if area < 800 or w < 25 or h < 25:
        continue
    # interior must be fully enclosed
    if x <= 1 or y <= 1 or x + w >= W - 1 or y + h >= H - 1:
        continue
    if (hlbl[i] == 0).sum() > 0.35 * (hlbl == 0).sum():  # touches background flood
        pass
    inter = (hlbl == i).astype(np.uint8)
    # the interior must be surrounded by ink (not just a gap in a sparse area)
    ring = cv2.dilate(inter, np.ones((9, 9), np.uint8)) & ~cv2.dilate(inter, np.ones((3, 3), np.uint8))
    ring_cov = float(sm[ring > 0].mean()) if ring.any() else 0.0
    if ring_cov < args.thr * 0.9:
        continue
    cands.append({'bbox': [int(x), int(y), int(w), int(h)], 'area': int(area),
                  'cent': [round(float(hce[i][0]), 1), round(float(hce[i][1]), 1)],
                  'ringCov': round(ring_cov, 4), 'mask': inter})

# ---- 3. congruence with the piece --------------------------------------
def contours_of(mask):
    m = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    return [c for c in cnts if cv2.contourArea(c) > 200]


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
    span = float(max(hi - lo))
    ctr = (lo + hi) / 2
    q = (p - ctr) + span / 2
    q = q / span * (S - 1)
    img = np.zeros((S, S), np.uint8)
    cv2.fillPoly(img, [q.round().astype(np.int32)], 1)
    return img


pc = contours_of(sil)
if not pc:
    print(json.dumps({'error': 'no silhouette contour'})); sys.exit(1)
A = raster(norm_pts(max(pc, key=cv2.contourArea)))

results = []
for c in cands:
    ic = contours_of(c['mask'])
    if not ic:
        continue
    p = norm_pts(max(ic, key=cv2.contourArea))
    if p is None:
        continue
    best = (0.0, 0, False)
    for flip in (False, True):
        Bf = p.copy()
        if flip:
            Bf[:, 0] *= -1
        for k in range(0, 360, 5):
            th = np.radians(k)
            R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
            ra = raster(Bf @ R.T)
            inter = np.logical_and(ra, A).sum()
            union = np.logical_or(ra, A).sum()
            iou = inter / union if union else 0.0
            if iou > best[0]:
                best = (iou, k, flip)
    # also the un-normalised scale ratio (area) — a hole must fit the piece
    results.append({'cent': c['cent'], 'bbox': c['bbox'], 'area': c['area'],
                    'ringCov': c['ringCov'], 'iou': round(float(best[0]), 3),
                    'rot': best[1], 'flip': best[2]})

results.sort(key=lambda r: -r['iou'])
out = {'size': [W, H], 'pieceSil': [int(sil.shape[1]), int(sil.shape[0])],
       'pieceArea': int(sil.sum()), 'candidates': results}

if args.out:
    vis = bg.copy() if bg.ndim == 3 else cv2.cvtColor(bg, cv2.COLOR_GRAY2BGR)
    for i, r in enumerate(results):
        col = (0, 0, 255) if i == 0 else (0, 165, 255)
        cv2.circle(vis, (int(r['cent'][0]), int(r['cent'][1])), 9, col, 2)
        cv2.putText(vis, f"{i}:IoU{r['iou']}", (int(r['cent'][0]) + 12, int(r['cent'][1]) + 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, col, 2)
    cv2.imwrite(args.out, cv2.resize(vis, (W * 2, H * 2), interpolation=cv2.INTER_CUBIC))

print(json.dumps(out, indent=1) if args.json else json.dumps(out))
