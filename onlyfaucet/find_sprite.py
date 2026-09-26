#!/usr/bin/env python3
"""Sprite-anchored hole detector.

Unlike find_hole.py (which derives the silhouette from the blue piece drawn on
the canvas) this uses the widget's own sprite PNG from the X-Captcha-Piece
header — the exact silhouette — and asks, for every position of the background:
"how strong are the edges *inside* that silhouette compared with the local
variation?"  (t-statistic style score, so positions are comparable across maps.)

Peaks that recur across several independent maps are clustered: a real hole
outline repeats, single-map artifacts do not.

Usage: find_sprite.py background.png sprite.png [--json]
"""
import sys, json, argparse
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('bg')
ap.add_argument('sprite')
ap.add_argument('--json', action='store_true')
args = ap.parse_args()

bg = cv2.imread(args.bg, cv2.IMREAD_UNCHANGED)
if bg is None:
    print(json.dumps({'error': 'bg unreadable'}))
    sys.exit(1)
if bg.shape[2] == 4:
    bgr, alpha = bg[:, :, :3], bg[:, :, 3]
else:
    bgr, alpha = bg, np.full(bg.shape[:2], 255, np.uint8)
H, W = bgr.shape[:2]
sp = cv2.imread(args.sprite, cv2.IMREAD_UNCHANGED)
if sp is None or sp.shape[2] < 4:
    print(json.dumps({'error': 'sprite unreadable'}))
    sys.exit(1)
sa = sp[:, :, 3]
sbgr = sp[:, :, :3]

# silhouette of the sprite (its opaque pixels), tight-cropped
ys, xs = np.nonzero(sa > 40)
if len(xs) < 50:
    print(json.dumps({'error': 'empty sprite alpha'}))
    sys.exit(1)
sx0, sx1 = xs.min(), xs.max() + 1
sy0, sy1 = ys.min(), ys.max() + 1
sil = (sa[sy0:sy1, sx0:sx1] > 40).astype(np.uint8)
sil = cv2.morphologyEx(sil, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
th, tw = sil.shape
ring = (cv2.dilate(sil, np.ones((3, 3), np.uint8)) - cv2.erode(sil, np.ones((3, 3), np.uint8))).astype(np.uint8)

gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)

# maps where a hole outline should stand out
g8 = gray.astype(np.uint8)
maps = {
    'canny': cv2.Canny(g8, 40, 110).astype(np.float32),
    'cannyB': cv2.Canny(cv2.GaussianBlur(g8, (0, 0), 1.8), 25, 80).astype(np.float32),
    'grad': cv2.magnitude(cv2.Sobel(gray, cv2.CV_32F, 1, 0, 3), cv2.Sobel(gray, cv2.CV_32F, 0, 1, 3)),
    'dog1': np.abs(cv2.GaussianBlur(g8, (0, 0), 1) - cv2.GaussianBlur(g8, (0, 0), 2)),
    'dog2': np.abs(cv2.GaussianBlur(g8, (0, 0), 2) - cv2.GaussianBlur(g8, (0, 0), 4)),
    'dog4': np.abs(cv2.GaussianBlur(g8, (0, 0), 4) - cv2.GaussianBlur(g8, (0, 0), 8)),
}
# darkness hypothesis: the hole interior may simply be dimmer than context
bright = (gray > 60).astype(np.float32)
num = cv2.GaussianBlur(gray * bright, (0, 0), 6)
den = np.maximum(cv2.GaussianBlur(bright, (0, 0), 6), 1e-3)
db = num / den
maps['dim'] = (cv2.GaussianBlur(db, (0, 0), 20) - db).astype(np.float32)

BORDER = 8
PEAK_R = 22


def score_map(M, k):
    """mean(k*M)/local-std(k*M): a hole-shaped burst of signal scores high."""
    kf = k.astype(np.float32)
    n = float(kf.sum())
    if n < 20:
        return None
    s1 = cv2.filter2D(M, -1, kf, borderType=cv2.BORDER_CONSTANT)
    s2 = cv2.filter2D(M * M, -1, kf, borderType=cv2.BORDER_CONSTANT)
    mean = s1 / n
    var = np.maximum(s2 / n - mean * mean, 0.0)
    return (mean / (np.sqrt(var) + 1e-6)).astype(np.float32)


peaks = []
combos = {'ring': ring, 'fill': sil}
for mname, M in maps.items():
    for kname, k in combos.items():
        S = score_map(M, k)
        if S is None:
            continue
        valid = S.copy()
        valid[:th + BORDER, :] = -1e9
        valid[-(th + BORDER):, :] = -1e9
        valid[:, :tw + BORDER] = -1e9
        valid[:, -(tw + BORDER):] = -1e9
        vals = valid[valid > -1e8]
        if vals.size < 10:
            continue
        med = float(np.median(vals))
        mad = float(np.median(np.abs(vals - med))) * 1.4826 + 1e-6
        flat = valid.ravel()
        order = np.argsort(flat)[::-1]
        got = 0
        seen = []
        for j, idx in enumerate(order):
            if j > 400000 or got >= 4:
                break
            if flat[idx] <= -1e8:
                break
            y, x = divmod(int(idx), valid.shape[1])
            px, py = x + tw / 2.0, y + th / 2.0
            if any((px - a) ** 2 + (py - b_) ** 2 < PEAK_R ** 2 for a, b_ in seen):
                continue
            seen.append((px, py))
            peaks.append({'x': px, 'y': py,
                          'z': round((float(flat[idx]) - med) / mad, 2),
                          'map': mname, 'tmpl': kname})
            got += 1

CLUSTER_R = 26.0
clusters = []
for p in peaks:
    for c in clusters:
        if (p['x'] - c['x']) ** 2 + (p['y'] - c['y']) ** 2 <= CLUSTER_R ** 2:
            c['peers'].append(p)
            c['maps'].add(p['map'])
            c['z'] = max(c['z'], p['z'])
            wsum = sum(max(q['z'], 0.1) for q in c['peers'])
            c['x'] = sum(q['x'] * max(q['z'], 0.1) for q in c['peers']) / wsum
            c['y'] = sum(q['y'] * max(q['z'], 0.1) for q in c['peers']) / wsum
            break
    else:
        clusters.append({'x': p['x'], 'y': p['y'], 'z': p['z'],
                         'maps': {p['map']}, 'peers': [p]})

clusters.sort(key=lambda c: (-len(c['maps']), -c['z']))
out = {
    'size': [W, H],
    'spriteSil': [int(tw), int(th)],
    'clusters': [{
        'x': round(c['x'], 1), 'y': round(c['y'], 1),
        'nMaps': len(c['maps']), 'z': round(c['z'], 2),
        'maps': sorted(c['maps']),
        'peers': [[q['map'], q['tmpl'], q['z']] for q in c['peers'][:10]],
    } for c in clusters[:8]],
}
print(json.dumps(out, indent=1) if args.json else json.dumps(out))
