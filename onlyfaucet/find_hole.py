#!/usr/bin/env python3
"""Find piece (blue outline) and ranked matching holes in OnlyFaucet puzzle PNG.

Holes = closed dashed-outline silhouettes; pick ones whose contour shape
best matches the piece (cv2.matchShapes I1 + area/bbox sanity filters),
searched across multiple dilation/closing settings.

Prints JSON:
  {pieceX,pieceY,targetX,targetY,w,h,score,cands:[{x,y,score},...]}
or null.
"""
import sys, json
import cv2
import numpy as np
from PIL import Image


def piece_region(r, g, b, w, h):
    blue = ((b > 140) & (b > r + 50) & (g > r + 20) & (g > 60)).astype(np.uint8)
    blue[:6, :] = blue[-6:, :] = 0
    blue[:, :6] = blue[:, -6:] = 0
    n, lab, st, _ = cv2.connectedComponentsWithStats(blue, 8)
    best, best_a = None, -1
    for i in range(1, n):
        area = int(st[i, cv2.CC_STAT_AREA])
        if area < 120 or area > w * h * 0.15:
            continue
        bw, bh = int(st[i, cv2.CC_STAT_WIDTH]), int(st[i, cv2.CC_STAT_HEIGHT])
        if bw < 30 or bh < 30:
            continue
        if bw > w * 0.7 or bh > h * 0.7:
            continue
        if area / max(bw * bh, 1) > 0.6:
            continue
        # Prefer larger, more complete outlines
        if area > best_a:
            best_a, best = area, i
    if best is None:
        return None, None, None
    pm = (lab == best).astype(np.uint8)
    filled = cv2.morphologyEx(pm, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    inv = 1 - filled
    mf = np.zeros((h + 2, w + 2), np.uint8)
    for xx, yy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if inv[yy, xx]:
            cv2.floodFill(inv, mf, (xx, yy), 0)
    solid = (inv > 0).astype(np.uint8)
    if solid.sum() < 30:
        solid = filled
    cnts, _ = cv2.findContours(solid, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None, None, None
    pcnt = max(cnts, key=cv2.contourArea)
    if cv2.contourArea(pcnt) < 40:
        return None, None, None
    # Grab point: a pixel on the blue stroke (top-left-ish of stroke)
    ys_x, xs_x = np.nonzero(pm)
    if len(xs_x):
        grab_idx = int(np.argmin(xs_x.astype(np.int32) + ys_x.astype(np.int32)))
        grab = (int(xs_x[grab_idx]), int(ys_x[grab_idx]))
    else:
        grab = None
    return solid, pcnt, grab


def hole_candidates(w, h, r, g, b, gray, pcnt, pa, pb, solid):
    white = ((gray > 70) & (r > 50) & (g > 50)).astype(np.uint8)
    pm = cv2.moments(pcnt)
    pcx, pcy = pm['m10'] / pm['m00'], pm['m01'] / pm['m00']
    results = {}
    for ksz in (3, 4, 5):
        for ck in (5, 7, 9):
            dil = cv2.dilate(white, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksz, ksz)), 1)
            dil = cv2.morphologyEx(dil, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ck, ck)))
            n, lab, st, _ = cv2.connectedComponentsWithStats(dil, 8)
            for i in range(1, n):
                area = int(st[i, cv2.CC_STAT_AREA])
                bw, bh = int(st[i, cv2.CC_STAT_WIDTH]), int(st[i, cv2.CC_STAT_HEIGHT])
                if area < 200 or bw > w * 0.9 or bh > h * 0.9:
                    continue
                ratio = area / pa
                if not (0.2 <= ratio <= 4.0):
                    continue
                cx, cy = st[i, cv2.CC_STAT_LEFT] + bw // 2, st[i, cv2.CC_STAT_TOP] + bh // 2
                if pb[0] - 12 <= cx <= pb[0] + pb[2] + 12 and pb[1] - 12 <= cy <= pb[1] + pb[3] + 12:
                    continue
                m = (lab == i).astype(np.uint8)
                m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8))
                inv2 = 1 - m
                mf2 = np.zeros((h + 2, w + 2), np.uint8)
                border = [(x, 0) for x in range(w)] + [(x, h - 1) for x in range(w)] + \
                         [(0, y) for y in range(h)] + [(w - 1, y) for y in range(h)]
                for xx, yy in border:
                    if inv2[yy, xx]:
                        cv2.floodFill(inv2, mf2, (xx, yy), 0)
                f2 = (inv2 > 0).astype(np.uint8)
                cc, _ = cv2.findContours(f2, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                if not cc:
                    continue
                cand = max(cc, key=cv2.contourArea)
                ca = cv2.contourArea(cand)
                if ca < 80:
                    continue
                try:
                    shape = cv2.matchShapes(pcnt, cand, cv2.CONTOURS_MATCH_I1, 0.0)
                except Exception:
                    continue
                cm = cv2.moments(cand)
                if cm['m00'] == 0:
                    continue
                tcx, tcy = cm['m10'] / cm['m00'], cm['m01'] / cm['m00']
                cb = cv2.boundingRect(cand)
                if cb[2] < pb[2] * 0.4 or cb[3] < pb[3] * 0.4:
                    continue
                if cb[2] > pb[2] * 2.5 or cb[3] > pb[3] * 2.5:
                    continue
                # Native-scale centroid-aligned IoU (piece never rotates/scales on drag)
                dx, dy = int(round(tcx - pcx)), int(round(tcy - pcy))
                mp = np.zeros_like(solid)
                ys0, ys1 = max(0, dy), min(h, h + dy)
                xs0, xs1 = max(0, dx), min(w, w + dx)
                # solid source window corresponding to dest
                sy0, sy1 = max(0, -dy), min(h, h - dy)
                sx0, sx1 = max(0, -dx), min(w, w - dx)
                mp[ys0:ys1, xs0:xs1] = solid[sy0:sy1, sx0:sx1]
                inter = int(np.logical_and(mp, f2).sum())
                union = int(np.logical_or(mp, f2).sum())
                iou = inter / max(union, 1)
                # Near-perfect shape match should dominate; otherwise favor IoU
                if shape < 0.05:
                    score = -2.0 - iou  # strongly prefer
                else:
                    score = -iou + min(shape, 1.5) * 0.35
                key = (int(tcx // 12) * 12, int(tcy // 12) * 12)
                if key not in results or score < results[key][0]:
                    results[key] = (float(score), float(shape), float(iou), float(tcx), float(tcy))
    ranked = sorted(results.values())
    return ranked


def main(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    a = np.asarray(im).astype(np.int16)
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    gray = (0.299 * r + 0.587 * g + 0.114 * b).astype(np.uint8)

    solid, pcnt, grab = piece_region(r, g, b, w, h)
    if pcnt is None:
        print('null')
        return
    M = cv2.moments(pcnt)
    pieceX, pieceY = int(M['m10'] / M['m00']), int(M['m01'] / M['m00'])
    pa = cv2.contourArea(pcnt)
    pb = cv2.boundingRect(pcnt)
    if grab is None:
        grab = (pieceX, pieceY)

    ranked = hole_candidates(w, h, r, g, b, gray, pcnt, pa, pb, solid)
    base = {
        'pieceX': pieceX, 'pieceY': pieceY,
        'grabX': int(grab[0]), 'grabY': int(grab[1]),
        'w': w, 'h': h, 'n': int(solid.sum()) if solid is not None else 0,
        'pieceBox': [int(pb[0]), int(pb[1]), int(pb[0] + pb[2]), int(pb[1] + pb[3])],
    }
    if not ranked:
        base.update({'targetX': w // 2, 'targetY': h // 2, 'fallback': True, 'cands': []})
        print(json.dumps(base))
        return
    best = ranked[0]
    base.update({
        'targetX': int(best[3]), 'targetY': int(best[4]),
        'score': round(best[0], 4),
        'shape': round(best[1], 4),
        'iou': round(best[2], 4),
        'cands': [{'x': int(x), 'y': int(y), 'score': round(s, 4),
                   'shape': round(sh, 4), 'iou': round(io, 4)}
                  for s, sh, io, x, y in ranked[:6]],
    })
    print(json.dumps(base))


if __name__ == '__main__':
    main(sys.argv[1])
