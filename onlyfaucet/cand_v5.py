#!/usr/bin/env python3
"""cand_v5.py — segment cartoon creatures from a captcha scene (450x280).

Usage:  cand_v5.py scene.png ...        -> JSON per scene on stdout
        cand_v5.py --dump scene.png     -> saves <name>.cand.png / .mask.png

Handles the two scene palettes:
  light (pastel bg) : mask = high saturation OR dark strokes
  dark  (night bg)  : mask = bright fills OR very dark strokes
Merged blobs (touching creatures/decor) are split by progressive erosion +
nearest-sub-label assignment before size filtering.
"""
import sys, json
import numpy as np
import cv2

# light-scene thresholds (tuned on labeled tutorial scenes)
S_THR, V_THR = 42, 75
# dark-scene thresholds
DARK_MEDIAN_V = 140       # scene median V at/below this -> dark mode
BRIGHT_V, STROKE_V = 105, 25
CLOSE_K, OPEN_K = 11, 2
# final per-creature component filters
MIN_AREA, MAX_AREA = 140, 4500
MIN_DIM, MAX_DIM = 12, 130
MAX_ASPECT = 5.0
# merge splitting
SPLIT_MIN_AREA = 2500     # components this big get erosion-split
SPLIT_ERODE = 5


def build_mask(bgr):
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    S, V = hsv[:, :, 1], hsv[:, :, 2]
    mode = "dark" if float(np.median(V)) < DARK_MEDIAN_V else "light"
    if mode == "dark":
        mask = ((V > BRIGHT_V) | (V < STROKE_V)).astype(np.uint8) * 255
    else:
        mask = ((S > S_THR) | (V < V_THR)).astype(np.uint8) * 255
    # open first: kills confetti chains between creatures before close can fuse them
    k2 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (OPEN_K, OPEN_K))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k2)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (CLOSE_K, CLOSE_K))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)
    return mask, mode


def watershed_split(comp):
    """Split a blob with no thin neck (overlapping bodies) using distance-transform
    peaks as markers. Returns list of pieces or None if <2 markers found."""
    d = cv2.distanceTransform(comp, cv2.DIST_L2, 5)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    mx = cv2.dilate(d, k)
    ys, xs = np.nonzero((np.abs(d - mx) < 1e-6) & (d > max(3.0, 0.15 * float(d.max()))))
    # dedupe peaks within 12px, keep the deepest first
    pts = []
    for _, x, y in sorted(zip(d[ys, xs], xs, ys), reverse=True):
        if all((int(x) - px) ** 2 + (int(y) - py) ** 2 >= 144 for px, py in pts):
            pts.append((int(x), int(y)))
    if len(pts) < 2:
        return None
    markers = np.zeros(d.shape, np.int32)
    for idx, (x, y) in enumerate(pts, 1):
        markers[y, x] = idx
    cv2.watershed(cv2.cvtColor(comp, cv2.COLOR_GRAY2BGR), markers)
    out = []
    for m in range(1, len(pts) + 1):
        piece = (((markers == m) & (comp > 0)).astype(np.uint8)) * 255
        if cv2.countNonZero(piece) >= MIN_AREA // 2:
            out.append(piece)
    return out if len(out) >= 2 else None


def split_component(comp, depth=0):
    """Split an oversized binary component: erode to break thin joins, label,
    then assign every original pixel to its nearest sub-label. Recursive —
    pieces still over the size caps are split again with deeper erosion."""
    area = cv2.countNonZero(comp)
    if area < SPLIT_MIN_AREA or depth >= 3:
        return [comp]
    ke = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (SPLIT_ERODE, SPLIT_ERODE))
    n = 1
    for iters in (2, 4, 7):
        er = cv2.erode(comp, ke, iterations=iters)
        n, sub = cv2.connectedComponents(er, 8)
        if n > 2:
            break
    if n <= 2:                       # erosion couldn't break it: try watershed
        pieces = watershed_split(comp)
        return pieces if pieces else [comp]
    # every comp pixel -> nearest eroded-core label
    core = (er > 0).astype(np.uint8)
    inv = (1 - core).astype(np.uint8)      # 0 at cores -> labels attach to cores
    _, ids = cv2.distanceTransformWithLabels(
        inv, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(core)
    lut = np.zeros(int(ids.max()) + 1, np.int32)
    lut[ids[ys, xs]] = sub[ys, xs]         # unique core-pixel id -> sub label
    mapped = lut[ids]
    mapped = np.where(comp > 0, mapped, 0)
    out = []
    for i in range(1, n + 1):
        piece = ((mapped == i) & (comp > 0)).astype(np.uint8) * 255
        if cv2.countNonZero(piece) < MIN_AREA // 2:
            continue
        px, py, pw, ph = cv2.boundingRect(piece)
        if (cv2.countNonZero(piece) > MAX_AREA or max(pw, ph) > MAX_DIM) and depth < 3:
            out.extend(split_component(piece, depth + 1))
        else:
            out.append(piece)
    return out or [comp]


def largest_blob_centroid(comp):
    """centroid of the biggest solid blob (body) after a generous close."""
    f = cv2.morphologyEx(comp, cv2.MORPH_CLOSE,
                         cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    n, lab, ss, cc = cv2.connectedComponentsWithStats(f, 8)
    if n <= 1:
        return None
    big = 1 + int(np.argmax(ss[1:, 4]))
    return cc[big], ss[big]


def candidates(bgr, dump_mask=None):
    mask, mode = build_mask(bgr)
    n, lab, stats, cent = cv2.connectedComponentsWithStats(mask, 8)
    comps = []
    for i in range(1, n):
        if stats[i][4] < MIN_AREA:
            continue
        comp = ((lab == i).astype(np.uint8)) * 255
        if stats[i][4] > SPLIT_MIN_AREA or max(stats[i][2], stats[i][3]) > MAX_DIM:
            comps.extend(split_component(comp))
        else:
            comps.append(comp)

    out = []
    for comp in comps:
        x, y, w, h = cv2.boundingRect(comp)
        area = int(cv2.countNonZero(comp))
        if area < MIN_AREA or area > MAX_AREA:
            continue
        if min(w, h) < MIN_DIM or max(w, h) > MAX_DIM:
            continue
        if max(w, h) / max(1, min(w, h)) > MAX_ASPECT:
            continue
        cen = largest_blob_centroid(comp)
        if cen is None:
            cx, cy = x + w / 2, y + h / 2
        else:
            (cx, cy), _ = cen
        out.append({"cx": round(float(cx), 1), "cy": round(float(cy), 1),
                    "x": int(x), "y": int(y), "w": int(w), "h": int(h),
                    "area": int(area)})
    out.sort(key=lambda c: (c["y"], c["x"]))
    if dump_mask is not None:
        cv2.imwrite(dump_mask, mask)
    return out, mask, mode


def main():
    args = sys.argv[1:]
    dump = "--dump" in args
    args = [a for a in args if a != "--dump"]
    for path in args:
        img = cv2.imread(path, cv2.IMREAD_COLOR)
        if img is None:
            print(json.dumps({"error": "cannot read " + path}))
            continue
        cands, mask, mode = candidates(img, path.replace(".png", ".mask.png") if dump else None)
        print(json.dumps({"file": path, "mode": mode, "count": len(cands),
                          "candidates": cands}))
        if dump:
            ov = img.copy()
            for i, c in enumerate(cands, 1):
                cv2.rectangle(ov, (c["x"], c["y"]), (c["x"] + c["w"], c["y"] + c["h"]),
                              (0, 0, 255), 1)
                cv2.putText(ov, str(i), (c["x"], max(12, c["y"] - 3)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 1)
                cv2.circle(ov, (int(c["cx"]), int(c["cy"])), 2, (255, 0, 0), -1)
            cv2.imwrite(path.replace(".png", ".cand.png"), ov)


if __name__ == "__main__":
    main()
