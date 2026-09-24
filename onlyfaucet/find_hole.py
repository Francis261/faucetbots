#!/usr/bin/env python3
"""Find piece (blue outline) and ranked matching holes in OnlyFaucet puzzle PNG.

Primary: orientation-locked Chamfer between piece contour and hole contour
(centroid-align + small local translation refine + best phase roll). Exact same
curved shape required — no rotation, no scale.

Prints JSON or null.
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
        if area > best_a:
            best_a, best = area, i
    if best is None:
        return None, None, None
    pm = (lab == best).astype(np.uint8)
    filled = cv2.morphologyEx(pm, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    inv = 1 - filled
    inv_p = cv2.copyMakeBorder(inv, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=1)
    mf = np.zeros((inv_p.shape[0] + 2, inv_p.shape[1] + 2), np.uint8)
    cv2.floodFill(inv_p, mf, (0, 0), 0)
    solid = inv_p[1:-1, 1:-1].astype(np.uint8)
    if solid.sum() < 30:
        solid = filled
    cnts, _ = cv2.findContours(solid, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None, None, None
    pcnt = max(cnts, key=cv2.contourArea)
    if cv2.contourArea(pcnt) < 40:
        return None, None, None
    ys_x, xs_x = np.nonzero(pm)
    if not len(xs_x):
        return solid, pcnt, None
    # Prefer a stroke pixel with many blue neighbors (mid-stroke, not a tip)
    blue_u8 = pm.astype(np.uint8)
    kern = np.ones((5, 5), np.uint8)
    dens = cv2.filter2D(blue_u8, -1, kern).astype(np.int32)
    dens_m = np.where(pm > 0, dens, -1).astype(np.int32)
    gy, gx = np.unravel_index(int(np.argmax(dens_m)), dens_m.shape)
    # Also keep classic top-left tip as fallback component
    gi = int(np.argmin(xs_x.astype(np.int32) + ys_x.astype(np.int32)))
    grab = (int(gx), int(gy))
    grab_alt = (int(xs_x[gi]), int(ys_x[gi]))
    # Store alt in module-level for main() via return of 4-tuple handled below
    piece_region.grab_alt = grab_alt
    return solid, pcnt, grab


def _resample_closed(cnt, cx, cy, n=96):
    pts = cnt.reshape(-1, 2).astype(np.float64) - np.array([cx, cy])
    if len(pts) < 3:
        return None
    pts = np.vstack([pts, pts[:1]])
    d = np.sqrt((np.diff(pts, axis=0) ** 2).sum(1))
    cum = np.concatenate([[0], np.cumsum(d)])
    total = cum[-1]
    if total < 1e-6:
        return None
    t = np.linspace(0, total, n, endpoint=False)
    return np.stack([np.interp(t, cum, pts[:, 0]), np.interp(t, cum, pts[:, 1])], 1)


def _chamfer_fast(A, B):
    """Symmetric Chamfer via broadcasting."""
    d1 = np.sqrt(((A[:, None, :] - B[None, :, :]) ** 2).sum(-1)).min(1).mean()
    d2 = np.sqrt(((B[:, None, :] - A[None, :, :]) ** 2).sum(-1)).min(1).mean()
    return 0.5 * (d1 + d2)


def refined_curve_dist(pcnt, cand, pcx, pcy, n=64, search=8, step=4):
    """Orientation-locked exact curve distance with local translation + phase refine."""
    A = _resample_closed(pcnt, pcx, pcy, n)
    M = cv2.moments(cand)
    if A is None or M['m00'] == 0:
        return 1.0
    bcx, bcy = M['m10'] / M['m00'], M['m01'] / M['m00']
    B0 = _resample_closed(cand, bcx, bcy, n)
    if B0 is None:
        return 1.0
    pb_ = cv2.boundingRect(pcnt)
    scale = max(np.hypot(pb_[2], pb_[3]), 1.0)
    best = 1e18
    best_k = 0
    best_off = np.zeros(2)
    rolls = list(range(0, n, max(1, n // 8)))
    for sy in range(-search, search + 1, step):
        for sx in range(-search, search + 1, step):
            off = np.array([sx, sy], dtype=np.float64)
            for k in rolls:
                d = _chamfer_fast(A, np.roll(B0, k, axis=0) + off)
                if d < best:
                    best = d
                    best_k = k
                    best_off = off
    # Fine phase ±k around best coarse roll + fine translation ±2
    Br = np.roll(B0, best_k, axis=0)
    for k in range(best_k - 2, best_k + 3):
        Brk = np.roll(B0, k % n, axis=0)
        for sy in range(-2, 3):
            for sx in range(-2, 3):
                d = _chamfer_fast(A, Brk + best_off + np.array([sx, sy], dtype=np.float64))
                if d < best:
                    best = d
    return float(min(best / scale, 1.0))


def extract_holes(w, h, gray, r, g, b, pb, pa):
    holes = []
    seen = set()

    def add(cand):
        M = cv2.moments(cand)
        if M['m00'] == 0:
            return
        tcx, tcy = M['m10'] / M['m00'], M['m01'] / M['m00']
        key = (int(tcx // 14) * 14, int(tcy // 14) * 14)
        if key in seen:
            return
        ca = cv2.contourArea(cand)
        if ca < 80:
            return
        cb = cv2.boundingRect(cand)
        if cb[2] < pb[2] * 0.35 or cb[3] < pb[3] * 0.35:
            return
        if cb[2] > pb[2] * 3.0 or cb[3] > pb[3] * 3.0:
            return
        ccx, ccy = cb[0] + cb[2] // 2, cb[1] + cb[3] // 2
        pcx0, pcy0 = pb[0] + pb[2] // 2, pb[1] + pb[3] // 2
        if abs(ccx - pcx0) < pb[2] * 0.4 and abs(ccy - pcy0) < pb[3] * 0.4:
            return
        seen.add(key)
        holes.append((cand, float(tcx), float(tcy)))

    white = ((gray > 70) & (r > 50) & (g > 50)).astype(np.uint8)

    # A: morphological
    for ksz in (3, 4, 5):
        for ck in (5, 7):
            dil = cv2.dilate(white, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksz, ksz)), 1)
            dil = cv2.morphologyEx(dil, cv2.MORPH_CLOSE,
                                   cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ck, ck)))
            n, lab, st, _ = cv2.connectedComponentsWithStats(dil, 8)
            for i in range(1, n):
                area = int(st[i, 4])
                bw, bh = int(st[i, 2]), int(st[i, 3])
                if area < 200 or bw > w * 0.9 or bh > h * 0.9:
                    continue
                if not (0.15 <= area / max(pa, 1) <= 5.0):
                    continue
                m = (lab == i).astype(np.uint8)
                m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8))
                # Fill holes via inverse flood from a single synthetic border seed
                inv = 1 - m
                inv_p = cv2.copyMakeBorder(inv, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=1)
                mf = np.zeros((inv_p.shape[0] + 2, inv_p.shape[1] + 2), np.uint8)
                cv2.floodFill(inv_p, mf, (0, 0), 0)
                f2 = inv_p[1:-1, 1:-1]
                cc, _ = cv2.findContours(f2, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                if not cc:
                    continue
                add(max(cc, key=cv2.contourArea))

    # B: edge-closed silhouettes
    edges = cv2.Canny(gray, 40, 120)
    for k in (5, 7, 9):
        chained = cv2.morphologyEx(edges, cv2.MORPH_CLOSE,
                                   cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
        chained = cv2.morphologyEx(chained, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        inv = 1 - chained
        inv_p = cv2.copyMakeBorder(inv, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=1)
        mf = np.zeros((inv_p.shape[0] + 2, inv_p.shape[1] + 2), np.uint8)
        cv2.floodFill(inv_p, mf, (0, 0), 0)
        filled = inv_p[1:-1, 1:-1]
        cnts, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cand in cnts:
            if cv2.contourArea(cand) >= 100:
                add(cand)

    # C: density anomalies
    wf = white.astype(np.float32)
    dens = cv2.GaussianBlur(wf, (0, 0), sigmaX=10, sigmaY=10)
    base = float(dens.mean())
    anom = (np.abs(dens - base) > dens.std() * 0.85).astype(np.uint8)
    anom = cv2.morphologyEx(anom, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(anom, 8)
    for i in range(1, n):
        area = int(st[i, 4])
        bw, bh = int(st[i, 2]), int(st[i, 3])
        if area < 250 or bw < 25 or bh < 25 or bw > w * 0.85 or bh > h * 0.85:
            continue
        m = (lab == i).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
        cc, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if cc:
            add(max(cc, key=cv2.contourArea))

    return holes


def _dt_outliers(w, h, r, g, b, gray, pcnt, pcx, pcy, pb):
    """Slide piece contour over dash-map DT; return extreme outliers only.

    On canvases where morphological detection works, DT has no clear
    winner (all dt~1.6-1.8) — returns []. On failed live shots where the
    true hole was missed, DT shows dt~0.4-0.5 with cov~1.0 — returns those.
    """
    white = ((gray > 70) & (r > 50) & (g > 50)).astype(np.uint8)
    blue = ((b > 140) & (b > r + 50) & (g > r + 20)).astype(np.uint8)
    white = ((white > 0) & (blue == 0)).astype(np.uint8)
    dt = cv2.distanceTransform(1 - white, cv2.DIST_L2, 3)
    A = _resample_closed(pcnt, pcx, pcy, n=64)
    if A is None:
        return []
    step = 4
    scored = []
    for cy in range(0, h, step):
        for cx in range(0, w, step):
            if abs(cx - pcx) < pb[2] * 0.4 and abs(cy - pcy) < pb[3] * 0.4:
                continue
            pts = A + np.array([cx, cy], dtype=np.float64)
            xs = np.clip(pts[:, 0].astype(int), 0, w - 1)
            ys = np.clip(pts[:, 1].astype(int), 0, h - 1)
            d = float(dt[ys, xs].mean())
            cov = float((dt[ys, xs] < 3.0).mean())
            if cov >= 0.90:
                scored.append((d, cx, cy, cov))
    if not scored:
        return []
    scored.sort()
    # Local refine best few
    out = []
    picked = []
    for d0, cx, cy, cov in scored:
        if any(abs(cx - px) < 24 and abs(cy - py) < 24 for _, px, py in picked):
            continue
        bestd, bx, by = d0, cx, cy
        for dy in range(-6, 7, 2):
            for dx in range(-6, 7, 2):
                pts = A + np.array([cx + dx, cy + dy], dtype=np.float64)
                xs = np.clip(pts[:, 0].astype(int), 0, w - 1)
                ys = np.clip(pts[:, 1].astype(int), 0, h - 1)
                dd = float(dt[ys, xs].mean())
                if dd < bestd:
                    bestd, bx, by = dd, cx + dx, cy + dy
        pts = A + np.array([bx, by], dtype=np.float64)
        xs = np.clip(pts[:, 0].astype(int), 0, w - 1)
        ys = np.clip(pts[:, 1].astype(int), 0, h - 1)
        cov2 = float((dt[ys, xs] < 3.0).mean())
        picked.append((bestd, bx, by))
        out.append((bestd, bx, by, cov2))
        if len(out) >= 4:
            break
    if not out:
        return []
    # Extreme-outlier gate: best must clearly beat the pack.
    # canvas1-style images have no outlier (all ~1.6+); failed shots have
    # best ~0.4-0.5 while rest are 1.4+.
    best_d = out[0][0]
    pack = [x[0] for x in out[1:]] or [best_d]
    pack_med = sorted(pack)[len(pack) // 2]
    if best_d < 1.0 and best_d < pack_med * 0.55 and out[0][3] >= 0.95:
        return [(bx, by, bestd) for bestd, bx, by, _ in out if bestd < best_d * 1.5 + 0.3]
    return []


def hole_candidates(w, h, r, g, b, gray, pcnt, pa, pb, solid):
    pm = cv2.moments(pcnt)
    pcx, pcy = pm['m10'] / pm['m00'], pm['m01'] / pm['m00']
    holes = extract_holes(w, h, gray, r, g, b, pb, pa)
    # Dash-along-boundary map: hole outlines are white dashes tracing the same curve
    white = ((gray > 70) & (r > 50) & (g > 50)).astype(np.uint8)
    blue = ((b > 140) & (b > r + 50) & (g > r + 20)).astype(np.uint8)
    white = ((white > 0) & (blue == 0)).astype(np.uint8)
    A_full = _resample_closed(pcnt, pcx, pcy, n=64)
    results = {}
    for cand, tcx, tcy in holes:
        pd = refined_curve_dist(pcnt, cand, pcx, pcy)
        if pd > 0.25:  # clearly a different silhouette
            continue
        try:
            shape = cv2.matchShapes(pcnt, cand, cv2.CONTOURS_MATCH_I1, 0.0)
        except Exception:
            shape = 1.0
        cb = cv2.boundingRect(cand)
        dx, dy = int(round(tcx - pcx)), int(round(tcy - pcy))
        fm = np.zeros((h, w), np.uint8)
        cv2.drawContours(fm, [cand], -1, 1, -1)
        mp = np.zeros_like(solid)
        ys0, ys1 = max(0, dy), min(h, h + dy)
        xs0, xs1 = max(0, dx), min(w, w + dx)
        sy0, sy1 = max(0, -dy), min(h, h - dy)
        sx0, sx1 = max(0, -dx), min(w, w - dx)
        mp[ys0:ys1, xs0:xs1] = solid[sy0:sy1, sx0:sx1]
        inter = int(np.logical_and(mp, fm).sum())
        union = int(np.logical_or(mp, fm).sum())
        iou = inter / max(union, 1)
        # Fraction of piece contour that sits on white dashes when placed at hole
        # (true hole outline traces the same curve with dashes)
        dash_cov = 0.0
        if A_full is not None:
            pts = A_full + np.array([tcx - pcx, tcy - pcy], dtype=np.float64)
            xs = np.clip(pts[:, 0].astype(int), 0, w - 1)
            ys = np.clip(pts[:, 1].astype(int), 0, h - 1)
            # dilate white slightly so nearby dashes count
            wd = cv2.dilate(white, np.ones((5, 5), np.uint8))
            dash_cov = float(wd[ys, xs].mean())
        size_pen = (abs(np.log(max(cb[2], 1) / max(pb[2], 1))) +
                    abs(np.log(max(cb[3], 1) / max(pb[3], 1))))
        # Exact curved shape first; dash coverage breaks near-ties among pd≈equal decoys.
        score = (pd
                 + 0.02 * max(0.0, 0.55 - dash_cov)  # penalize holes without dashes on boundary
                 + 1e-6 * min(size_pen, 3.0)
                 + 1e-6 * min(shape, 1.0)
                 - 1e-6 * iou)
        key = (int(tcx // 14) * 14, int(tcy // 14) * 14)
        if key not in results or score < results[key][0]:
            results[key] = (float(score), float(shape), float(iou),
                            float(tcx), float(tcy), float(pd), float(dash_cov))
    ranked = sorted(results.values())

    # Merge DT extreme outliers (missed true holes on live failures).
    # Only fire when no morphological candidate already has strong pd,
    # so canvas1 (pd=0.0405) is never overridden.
    strong = ranked and ranked[0][5] <= 0.050
    if not strong:
        for bcx, bcy, bdt in _dt_outliers(w, h, r, g, b, gray, pcnt, pcx, pcy, pb):
            key = (int(bcx // 14) * 14, int(bcy // 14) * 14)
            pd_est = 0.02 + 0.05 * max(0.0, bdt - 0.4)
            score = pd_est
            if key not in results and not any(
                    abs(bcx - x) < 20 and abs(bcy - y) < 20
                    for _, _, _, x, y, *_ in ranked):
                ranked.append((score, 0.0, 0.0, float(bcx), float(bcy), float(pd_est), 0.0))
        ranked.sort()
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
    grab_alt = getattr(piece_region, 'grab_alt', grab)

    ranked = hole_candidates(w, h, r, g, b, gray, pcnt, pa, pb, solid)
    base = {
        'pieceX': pieceX, 'pieceY': pieceY,
        'grabX': int(grab[0]), 'grabY': int(grab[1]),
        'grabAltX': int(grab_alt[0]), 'grabAltY': int(grab_alt[1]),
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
        'ptdist': round(best[5], 4),
        'dash': round(best[6], 4) if len(best) > 6 else None,
        'cands': [{'x': int(x), 'y': int(y), 'score': round(s, 4),
                   'shape': round(sh, 4), 'iou': round(io, 4),
                   'ptdist': round(pd, 4),
                   'dash': round(c[6], 4) if len(c) > 6 else None}
                  for c in ranked[:6]
                  for s, sh, io, x, y, pd, *_ in [c]],
    })
    print(json.dumps(base))


if __name__ == '__main__':
    main(sys.argv[1])
