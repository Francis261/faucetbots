#!/usr/bin/env python3
"""Find the hole by the chain of dashes that traces it.

Background of the puzzle: a navy field sprinkled with dashes, plus a *closed
chain* of dashes outlining the silhouette the piece came from.  The piece
sprite (from the X-Captcha-Piece header) is the exact silhouette, so the
outline of that silhouette used as a matched filter over the dash mask localises
the hole directly — no morphological guesswork.

Two independent corroborations are reported:
  z        matched-filter z-score of the best peak vs the rest of the map
  support  number of (blur, threshold) settings whose enclosed-dash-interior
           detection lands on the same spot
  iou0     how well that enclosed interior matches the silhouette in the
           piece's own orientation (a hole accepts the piece as drawn)

Usage: find_chain.py shot.png [--sprite s.png] [--geom x,y] [--rect x,y,w,h]
                      [--canvas 450x280] [--json] [--out overlay.png]

Output contract matches find_hole.py so bot.mjs can use either: every
coordinate is in IMAGE pixels of the given screenshot (the clip space the
caller drags in).  --geom takes CANVAS coordinates (450x280) and --rect says
where the canvas sits inside the image (the shot covers the widget host box,
border/padding included); the background PNG captured from the widget is the
canvas itself, so there --rect can be omitted.
Lower `score` is better (score = 1/z), `ptdist` shrinks as confidence grows.
"""
import sys, json, argparse
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('img')
ap.add_argument('--sprite', default=None)
ap.add_argument('--geom', default=None, help='piece centre in CANVAS coords: x,y')
ap.add_argument('--rect', default=None,
                help='canvas region inside the image, image px: x,y,w,h '
                     '(the screenshot covers the host box incl. border/padding)')
ap.add_argument('--canvas', default='450x280')
ap.add_argument('--json', action='store_true')
ap.add_argument('--out', default=None)
args = ap.parse_args()

CW, CH = (int(v) for v in args.canvas.lower().split('x'))
img = cv2.imread(args.img, cv2.IMREAD_UNCHANGED)
if img is None:
    print(json.dumps({'error': 'unreadable'})); sys.exit(1)
if img.ndim == 2:
    img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
elif img.shape[2] == 4:
    img = img[:, :, :3]
IH, IW = img.shape[:2]
if args.rect:
    RX, RY, RW, RH = (float(v) for v in args.rect.split(','))
else:
    RX, RY, RW, RH = 0.0, 0.0, float(IW), float(IH)
sx, sy = RW / CW, RH / CH          # canvas -> image px (inside the canvas box)

# ---------------------------------------------------------------- dash mask
g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
med = cv2.medianBlur(g, 15 if min(IW, IH) > 200 else 9)
# The median of a 15x15 window is always the FIELD colour (dashes never fill
# it), so dashes sit on whichever side of the median is farther out: brighter
# on the old navy theme (light dashes), darker on the current beige theme
# (dark dashes).  Taking only the bright sign silently produced an EMPTY mask
# on the beige widget (density ~0.0000): z-scores then measured noise (z=34
# at cover 0.02) and the gate dragged to a garbage peak, which the site
# rejected.  abs() covers both themes and is a no-op on navy-era captures.
dash = (np.abs(g.astype(np.int16) - med.astype(np.int16)) > 12).astype(np.float32)

# --------------------------------------------------- the piece (blue stroke)
b, gg, r = img[:, :, 0].astype(np.int16), img[:, :, 1].astype(np.int16), img[:, :, 2].astype(np.int16)
blue = ((b - (gg + r) / 2) > 35) & (b > 90)
# the widget frame is blue too — ignore anything hugging the image edge
edge = np.zeros_like(blue)
edge[:8, :] = edge[-8:, :] = True
edge[:, :8] = edge[:, -8:] = True
blue = blue & ~edge
piece = None
if args.geom:
    gx, gy = (float(v) for v in args.geom.split(','))
    piece = (RX + gx * sx, RY + gy * sy)
if piece is None and blue.sum() > 200:
    n, lbl, st, ce = cv2.connectedComponentsWithStats(blue.astype(np.uint8), 8)
    best = None
    for i in range(1, n):
        if st[i, 4] < 300:
            continue
        if best is None or st[i, 4] > st[best, 4]:
            best = i
    if best is not None:
        piece = (float(ce[best][0]), float(ce[best][1]))

# ------------------------------------------------- matched filter on dashes
sil = None
zmap = None
tolmap = None
if args.sprite:
    sp = cv2.imread(args.sprite, cv2.IMREAD_UNCHANGED)
    if sp is not None and sp.ndim == 3 and sp.shape[2] == 4:
        a = sp[:, :, 3]
        ys, xs = np.nonzero(a > 40)
        if len(xs) > 50:
            s0 = (a[ys.min():ys.max() + 1, xs.min():xs.max() + 1] > 40).astype(np.uint8)
            th, tw = max(3, int(round(s0.shape[0] * sy))), max(3, int(round(s0.shape[1] * sx)))
            sil = cv2.resize(s0, (tw, th), interpolation=cv2.INTER_NEAREST)
            sil = (sil > 0).astype(np.uint8)

if sil is not None:
    ring = (cv2.dilate(sil, np.ones((5, 5), np.uint8)) -
            cv2.erode(sil, np.ones((5, 5), np.uint8))).astype(np.float32)
    if ring.sum() > 50:
        zmap = cv2.GaussianBlur(cv2.matchTemplate(dash, ring, cv2.TM_CCORR) / ring.sum(), (0, 0), 3)
        mu, sd = float(zmap.mean()), float(zmap.std()) + 1e-9
        # Tolerant variant: count a dash as lying on the outline if it is within
        # ~2px, so a chain whose dashes straddle the band still scores.  This is
        # the "is a chain really hugging this silhouette" number (coverage 0..1);
        # the strict z above decides *where*, this one decides *whether*.
        near = cv2.dilate(dash, np.ones((5, 5), np.uint8)).astype(np.float32)
        tolmap = cv2.GaussianBlur(cv2.matchTemplate(near, ring, cv2.TM_CCORR) / ring.sum(),
                                  (0, 0), 3)

# --------------------------------------------------------------- piece info
# Coordinates are reported in IMAGE px (the screenshot/clip space), exactly
# like find_hole.py: bot.mjs converts them to canvas units via clipToCanvas().
pieceX = pieceY = grabX = grabY = None
if piece is not None:
    pieceX, pieceY = round(piece[0], 1), round(piece[1], 1)
    grabX, grabY = pieceX, pieceY
if blue.sum() > 200:
    ys, xs = np.nonzero(blue)
    if pieceX is None:
        pieceX = round((xs.min() + xs.max()) / 2, 1)
        pieceY = round((ys.min() + ys.max()) / 2, 1)

if sil is None or zmap is None:
    # No silhouette => the chain cannot be matched.  Interior blobs alone are
    # decoy clouds, so report WEAK and let the caller bail rather than guess.
    print(json.dumps({'pieceX': pieceX, 'pieceY': pieceY, 'grabX': grabX, 'grabY': grabY,
                      'grabAltX': grabX, 'grabAltY': grabY, 'w': IW, 'h': IH,
                      'z': None, 'z2': None, 'margin': None, 'sprite': False,
                      'cands': [], 'targetX': None, 'targetY': None,
                      'fallback': True, 'ptdist': 1.0}))
    sys.exit(0)

# ------------------------------------------- enclosed-dash-interior probes
interiors = []          # (nthr, cx, cy, area, w, h, mask, blur, thr)
for blur in (3, 4, 5, 6):
    sm = cv2.GaussianBlur(dash, (0, 0), blur)
    for thr in (0.10, 0.12, 0.14, 0.16, 0.18):
        binm = (sm > thr).astype(np.uint8)
        nh, hlbl, hst, hce = cv2.connectedComponentsWithStats((1 - binm).astype(np.uint8), 8)
        for i in range(1, nh):
            x, y, w, h, area = hst[i]
            if area < 500 or w < 30 or h < 30:
                continue
            if x <= 1 or y <= 1 or x + w >= IW - 1 or y + h >= IH - 1:
                continue
            interiors.append((int(area), float(hce[i][0]), float(hce[i][1]),
                              int(w), int(h), (hlbl == i).astype(np.uint8), blur, thr))

# cluster interiors by centre (image px, 22px tolerance)
clusters = []
for area, cx, cy, w, h, m, blur, thr in sorted(interiors, key=lambda t: -t[0]):
    for c in clusters:
        if (cx - c['cx']) ** 2 + (cy - c['cy']) ** 2 <= 22 ** 2:
            c['nthr'] += 1
            c['area'] = max(c['area'], area)
            if m.sum() > c['mask'].sum():
                c['mask'], c['w'], c['h'] = m, w, h
            c['cx'] = (c['cx'] * (c['nthr'] - 1) + cx) / c['nthr']
            c['cy'] = (c['cy'] * (c['nthr'] - 1) + cy) / c['nthr']
            break
    else:
        clusters.append({'cx': cx, 'cy': cy, 'area': area, 'w': w, 'h': h,
                         'mask': m, 'nthr': 1, 'blur': blur, 'thr': thr})

# drop interiors that belong to the piece itself (its blue outline closes too)
if piece is not None:
    px_, py_ = piece
    keep = []
    for c in clusters:
        if (c['cx'] - px_) ** 2 + (c['cy'] - py_) ** 2 < (58 * sx) ** 2:
            continue
        keep.append(c)
    clusters = keep


def norm_pts(c, N=192):
    M = cv2.moments(c)
    if M['m00'] <= 0:
        return None
    p = c.astype(np.float64).reshape(-1, 2) - np.array([M['m10'] / M['m00'], M['m01'] / M['m00']])
    p /= np.sqrt(M['m00'])
    q = np.vstack([p, p[:1]])
    d = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(q, axis=0), axis=1))]
    if d[-1] <= 0:
        return None
    t = np.linspace(0, d[-1], N, endpoint=False)
    return np.stack([np.interp(t, d, q[:, 0]), np.interp(t, d, q[:, 1])], 1)


def raster(p, S=96, pad=1.5):
    lo, hi = p.min(0) - pad, p.max(0) + pad
    span = float(max(hi - lo))
    q = ((p - (lo + hi) / 2) + span / 2) / span * (S - 1)
    im = np.zeros((S, S), np.uint8)
    cv2.fillPoly(im, [q.round().astype(np.int32)], 1)
    return im


def ious(mask, ref):
    """IoU of an interior against the silhouette, at its own orientation and
    at the best rotation/reflection (the latter catches rotated holes)."""
    cnts, _ = cv2.findContours(cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)),
                               cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cnts = [c for c in cnts if cv2.contourArea(c) > 150]
    if not cnts or ref is None:
        return 0.0, 0.0
    p = norm_pts(max(cnts, key=cv2.contourArea))
    if p is None:
        return 0.0, 0.0
    A = raster(ref)
    th = 0.0
    ri = 0.0
    best = 0.0
    for k in range(0, 360, 5):
        ang = np.radians(k)
        R = np.array([[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]])
        ra = raster(p @ R.T)
        inter = np.logical_and(ra, A).sum()
        uni = np.logical_or(ra, A).sum()
        v = inter / uni if uni else 0.0
        if k == 0:
            th = v
        if v > best:
            best, ri = v, k
    return float(th), float(best)


ref = None
if sil is not None:
    cs, _ = cv2.findContours(sil, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if cs:
        ref = norm_pts(max(cs, key=cv2.contourArea))

# ------------------------------------------------------- rank the clusters
def z_at(cx, cy):
    if zmap is None:
        return None
    ix = int(round(cx)) - sil.shape[1] // 2
    iy = int(round(cy)) - sil.shape[0] // 2
    ix = max(0, min(zmap.shape[1] - 1, ix))
    iy = max(0, min(zmap.shape[0] - 1, iy))
    return float((zmap[iy, ix] - mu) / sd)


def z_peak_near(cx, cy, rad=40):
    """best z inside a radius (image px) around a point"""
    if zmap is None:
        return None, None
    x0 = max(0, int(cx - rad - sil.shape[1] // 2))
    y0 = max(0, int(cy - rad - sil.shape[0] // 2))
    x1 = min(zmap.shape[1], int(cx + rad - sil.shape[1] // 2) + 1)
    y1 = min(zmap.shape[0], int(cy + rad - sil.shape[0] // 2) + 1)
    if x1 <= x0 or y1 <= y0:
        return None, None
    win = zmap[y0:y1, x0:x1]
    _, mx, _, loc = cv2.minMaxLoc(win)
    zx = (x0 + loc[0]) + sil.shape[1] // 2
    zy = (y0 + loc[1]) + sil.shape[0] // 2
    return float((mx - mu) / sd), (float(zx), float(zy))


# ------------------------------------------- rank matched-filter peaks (NMS)
# The z-map peaks are the primary signal; enclosed interiors only corroborate
# (support count, shape IoU, a second position estimate).  Each peak is merged
# with AT MOST one nearby interior (32px) so two peaks of the same chain can
# never share a z — that used to collapse the margin to 1.0 and fail the gate.
R_NMS = max(26, int(40 * sx))
peaks = []
if zmap is not None:
    sc = zmap.copy()
    for _ in range(10):
        _, mx, _, loc = cv2.minMaxLoc(sc)
        zc = float((mx - mu) / sd)
        cx = float(loc[0] + sil.shape[1] // 2)
        cy = float(loc[1] + sil.shape[0] // 2)
        if zc < 1.0:
            break
        near_piece = piece is not None and \
            (cx - piece[0]) ** 2 + (cy - piece[1]) ** 2 < (58 * sx) ** 2
        if not near_piece:
            peaks.append((zc, cx, cy))
        cv2.circle(sc, loc, R_NMS, 0, -1)

ranked = []
claimed = set()
for zc, cx, cy in peaks:
    ent = {'x': cx, 'y': cy, 'z': zc, 'nthr': 0, 'area': 0, 'box': None,
           'iou0': None, 'iouRot': None, 'chainX': None, 'chainY': None}
    bi, bd = None, (32 * sx) ** 2
    for i, c in enumerate(clusters):
        if i in claimed:
            continue
        d2 = (c['cx'] - cx) ** 2 + (c['cy'] - cy) ** 2
        if d2 <= bd:
            bi, bd = i, d2
    if bi is not None:
        c = clusters[bi]
        claimed.add(bi)
        iou0, ioub = ious(c['mask'], ref)
        ent.update({'nthr': c['nthr'], 'area': int(c['area']),
                    'box': [int(c['w']), int(c['h'])], 'iou0': round(iou0, 3),
                    'iouRot': round(ioub, 3),
                    'chainX': round(c['cx'], 1), 'chainY': round(c['cy'], 1)})
    ranked.append(ent)

# interiors no peak landed on: weaker candidates with their own local z
for i, c in enumerate(clusters):
    if i in claimed:
        continue
    zv, _ = z_peak_near(c['cx'], c['cy'], 16)
    if zv is None or zv < 0.8:
        continue
    iou0, ioub = ious(c['mask'], ref)
    ranked.append({'x': c['cx'], 'y': c['cy'], 'z': zv, 'nthr': c['nthr'],
                   'area': int(c['area']), 'box': [int(c['w']), int(c['h'])],
                   'iou0': round(iou0, 3), 'iouRot': round(ioub, 3),
                   'chainX': round(c['cx'], 1), 'chainY': round(c['cy'], 1)})

ranked.sort(key=lambda c: (-(c['z'] or 0), -(c['nthr'] or 0)))

# Positional NMS over the merged ranking.  A cluster entry resolves z from the
# NEAREST z-map peak but keeps the cluster's own centre, so two interiors next
# to one strong peak report byte-identical z at two nearby centres — that
# collapsed margin to 1.00 and failed the gate on a read where support=7 and
# iou0=0.92 said the opposite (verify5).  Two spots within 32px are the same
# hypothesis, not a competing one, so the weaker duplicate is dropped and the
# margin measures real alternatives only.
dedup = []
for c in ranked:
    if any((c['x'] - d['x']) ** 2 + (c['y'] - d['y']) ** 2 <= (32 * sx) ** 2
           for d in dedup):
        continue
    dedup.append(c)
ranked = dedup

zs = [c['z'] for c in ranked if c['z'] is not None]
z0 = zs[0] if zs else None
z1 = zs[1] if len(zs) > 1 else None

base = {
    'pieceX': pieceX, 'pieceY': pieceY,
    'grabX': grabX, 'grabY': grabY,
    'grabAltX': grabX, 'grabAltY': grabY,
    'w': IW, 'h': IH,
    'z': round(z0, 2) if z0 is not None else None,
    'z2': round(z1, 2) if z1 is not None else None,
    'sprite': bool(sil is not None),
    'cands': [],
}
if not ranked:
    base.update({'targetX': None, 'targetY': None, 'fallback': True, 'ptdist': 1.0})
    print(json.dumps(base))
    sys.exit(0)

best = ranked[0]
z0 = best['z'] if best['z'] is not None else 0.0
z1 = ranked[1]['z'] if len(ranked) > 1 and ranked[1]['z'] is not None else 0.0

# --------------------------------------------- tolerant outline coverage
# cover   fraction of the silhouette outline lying within ~2px of a dash
# cover2  the same for the best OTHER spot (NMS, piece excluded)
# coverGap separates "one unique chain" from "dense dashes everywhere"
cover = cover2 = None
if tolmap is not None:
    def cov_at(cx, cy):
        ix = max(0, min(tolmap.shape[1] - 1, int(round(cx)) - sil.shape[1] // 2))
        iy = max(0, min(tolmap.shape[0] - 1, int(round(cy)) - sil.shape[0] // 2))
        return float(tolmap[iy, ix])

    cover = cov_at(best['x'], best['y'])
    sc2 = tolmap.copy()
    R2 = max(30, int(30 * sx))
    cover2 = 0.0
    for _ in range(6):
        _, mx2, _, loc = cv2.minMaxLoc(sc2)
        cx2 = float(loc[0] + sil.shape[1] // 2)
        cy2 = float(loc[1] + sil.shape[0] // 2)
        cv2.circle(sc2, loc, R2, 0, -1)
        if piece is not None and (cx2 - piece[0]) ** 2 + (cy2 - piece[1]) ** 2 < (58 * sx) ** 2:
            continue
        if (cx2 - best['x']) ** 2 + (cy2 - best['y']) ** 2 < (32 * sx) ** 2:
            continue
        cover2 = float(mx2)
        break

# score: lower is better.  ptdist: 0..1, shrinks as the peak sharpens.
score0 = 1.0 / max(z0, 0.05)
ptdist = 1.0 / (max(z0, 0.0) * 1.5 + 5.0)
base.update({
    'targetX': int(round(best['x'])), 'targetY': int(round(best['y'])),
    'score': round(score0, 4), 'ptdist': round(ptdist, 4),
    'margin': round(z0 / z1, 3) if z1 > 0 else None,
    'support': int(best.get('nthr', 0)),
    'iou0': best.get('iou0'), 'iouRot': best.get('iouRot'),
    'cover': round(cover, 3) if cover is not None else None,
    'cover2': round(cover2, 3) if cover2 is not None else None,
    'coverGap': round(cover - cover2, 3) if (cover is not None and cover2 is not None) else None,
    'chainX': best.get('chainX'), 'chainY': best.get('chainY'),
    'cands': [{
        'x': int(round(c['x'])), 'y': int(round(c['y'])),
        'score': round(1.0 / max(c['z'] or 0.0, 0.05), 4),
        'z': round(c['z'], 2) if c['z'] is not None else None,
        'shape': None, 'iou': c.get('iou0'), 'ptdist': None,
        'nthr': c.get('nthr'), 'area': c.get('area'),
    } for c in ranked[:6]],
})
if args.out:
    vis = img.copy()
    for i, c in enumerate(ranked[:4]):
        col = (0, 0, 255) if i == 0 else (0, 165, 255)
        p = (int(c['x']), int(c['y']))
        cv2.circle(vis, p, 16, col, 2)
        cv2.putText(vis, f"{i} z={c['z'] and round(c['z'],1)}", (p[0] + 18, p[1] + 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, col, 2)
    if piece is not None:
        cv2.circle(vis, (int(piece[0]), int(piece[1])), 12, (255, 255, 0), 2)
    cv2.imwrite(args.out, vis)
print(json.dumps(base, indent=1) if args.json else json.dumps(base))
