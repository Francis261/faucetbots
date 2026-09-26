#!/usr/bin/env python3
"""Ground truth for the drag puzzle.

The widget fetches a pristine background PNG and draws it on its 450x280 canvas,
then draws the hole and the piece on top.  Subtracting the pristine background
(affine-scaled into the rendered widget's pixel grid) from the rendered widget
leaves exactly what the widget added: the hole, plus the piece (whose position
we already know from X-Captcha-Piece).

  diff_truth.py widget.png bg.png --geom x,y [--sprite sprite.png] [--json]

Reports the strongest non-piece blob in canvas coordinates (450x280).
"""
import sys, json, argparse
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('widget')
ap.add_argument('bg')
ap.add_argument('canvas', nargs='?', default='450x280')
ap.add_argument('--geom', default=None, help='piece centre in canvas coords: x,y')
ap.add_argument('--sprite', default=None)
ap.add_argument('--json', action='store_true')
ap.add_argument('--out', default=None, help='write annotated overlay png')
args = ap.parse_args()

CW, CH = (int(v) for v in args.canvas.lower().split('x'))
w = cv2.imread(args.widget, cv2.IMREAD_UNCHANGED)
bg = cv2.imread(args.bg, cv2.IMREAD_UNCHANGED)
if w is None or bg is None:
    print(json.dumps({'error': 'unreadable input'})); sys.exit(1)
if w.ndim == 2: w = cv2.cvtColor(w, cv2.COLOR_GRAY2BGR)
if bg.ndim == 3 and bg.shape[2] == 4: bg = bg[:, :, :3]

RW, RH = w.shape[1], w.shape[0]
sx, sy = RW / CW, RH / CH

bgs = cv2.resize(bg, (RW, RH), interpolation=cv2.INTER_AREA)

# Signed residual.  Subtractive resampling noise on the dash texture is
# symmetric, so the *signed* mean collapses to ~0 while anything the widget
# painted on top (a translucent silhouette, or an erased run of dashes) survives
# a modest blur as a solid plateau.
res = w.astype(np.float32) - bgs.astype(np.float32)
mag = cv2.GaussianBlur(np.abs(res).max(axis=2), (0, 0), 2.0)
signed = cv2.GaussianBlur(res.mean(axis=2), (0, 0), 3.0)

# exclude the piece: we know where it is
mask = np.ones_like(mag, np.uint8) * 255
piece_box = None
if args.geom:
    gx, gy = (float(v) for v in args.geom.split(','))
    piece_box = (gx, gy)
    r = 70.0
    cv2.circle(mask, (int(round(gx * sx)), int(round(gy * sy))), int(round(r * sx)), 0, -1)
if args.sprite:
    sp = cv2.imread(args.sprite, cv2.IMREAD_UNCHANGED)
    if sp is not None and sp.ndim == 3 and sp.shape[2] == 4:
        ys, xs = np.nonzero(sp[:, :, 3] > 40)
        if len(xs):
            if piece_box:
                cx = int(round(piece_box[0] * sx)); cy = int(round(piece_box[1] * sy))
                x0 = int(round(cx - sp.shape[1] / 2)); y0 = int(round(cy - sp.shape[0] / 2))
                cv2.rectangle(mask, (max(0, x0 - 4), max(0, y0 - 4)),
                              (min(RW - 1, x0 + sp.shape[1] + 4), min(RH - 1, y0 + sp.shape[0] + 4)), 0, -1)

m = mag.copy()
m[mask == 0] = 0
# ignore a 6px frame (the widget's rounded border / anti-aliasing)
m[:6, :] = 0; m[-6:, :] = 0; m[:, :6] = 0; m[:, -6:] = 0

# low-frequency signal: a painted overlay forms a plateau, dash-resampling noise
# does not.  Detection runs on this, metrics are reported from both.
sig = cv2.GaussianBlur(signed, (0, 0), 4.0)
sig[mask == 0] = 0
sig[:6, :] = 0; sig[-6:, :] = 0; sig[:, :6] = 0; sig[:, -6:] = 0

thr = max(5.0, float(np.percentile(np.abs(sig), 99.5)))
binm = (np.abs(sig) > thr).astype(np.uint8)
binm = cv2.morphologyEx(binm, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
binm = cv2.morphologyEx(binm, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
n, lbl, stats, cent = cv2.connectedComponentsWithStats(binm, 8)

blobs = []
for i in range(1, n):
    x, y, bw, bh, area = stats[i]
    if area < 150: continue
    sel = lbl == i
    blobs.append({
        'area': int(area),
        'widgetPx': [round(float(cent[i][0]), 1), round(float(cent[i][1]), 1)],
        'canvas': [round(float(cent[i][0]) / sx, 1), round(float(cent[i][1]) / sy, 1)],
        'bboxCanvas': [round(x / sx, 1), round(y / sy, 1), round(bw / sx, 1), round(bh / sy, 1)],
        'signedMean': round(float(sig[sel].mean()), 1),
        'signedAbsMean': round(float(np.abs(sig[sel]).mean()), 1),
        'absPeak': round(float(m[sel].max()), 1),
    })
blobs.sort(key=lambda b: -b['area'])

out = {
    'widget': [RW, RH], 'canvas': [CW, CH], 'scale': [round(sx, 4), round(sy, 4)],
    'threshold': round(float(thr), 1),
    'global': {'signedP1': round(float(np.percentile(sig, 1)), 1),
               'signedP50': round(float(np.percentile(sig, 50)), 1),
               'signedP99': round(float(np.percentile(sig, 99)), 1),
               'absMedian': round(float(np.median(mag)), 1),
               'absMax': round(float(mag.max()), 1)},
    'piece': piece_box,
    'blobs': blobs[:6],
}
if args.out:
    vis = w.copy()
    for b in blobs:
        cx, cy = int(b['widgetPx'][0]), int(b['widgetPx'][1])
        cv2.circle(vis, (cx, cy), 14, (0, 0, 255), 2)
        cv2.putText(vis, f"{b['canvas'][0]:.0f},{b['canvas'][1]:.0f}", (cx + 16, cy + 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
    if piece_box:
        cv2.circle(vis, (int(piece_box[0] * sx), int(piece_box[1] * sy)), 10, (0, 255, 255), 2)
    hmap = np.clip(np.abs(sig) * 8, 0, 255).astype(np.uint8)
    hmap = cv2.applyColorMap(hmap, cv2.COLORMAP_INFERNO)
    ov = np.concatenate([vis, hmap], axis=1)
    cv2.imwrite(args.out, ov)

print(json.dumps(out, indent=1) if args.json else json.dumps(out))
