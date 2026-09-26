#!/usr/bin/env python3
"""Explore where the hidden hole could be in an OnlyFaucet puzzle shot.

Idea: the hole is the *same silhouette* as the blue piece, revealed only by a
subtle change in the dash field (density and/or background tone). So:
  1. extract the piece silhouette as a template
  2. build anomaly maps (dash density, lightness) with the local mean removed
  3. slide the template over each map (orientation-locked) and report peaks
Prints a JSON ranking and writes an overlay PNG.
"""
import sys, os, json
import cv2
import numpy as np
from PIL import Image

path = sys.argv[1]
out_prefix = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(path)[0] + '-explore'

im = Image.open(path).convert('RGB')
W, H = im.size
a = np.asarray(im).astype(np.float32)
r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
gray = 0.299 * r + 0.587 * g + 0.114 * b

# --- piece silhouette -------------------------------------------------------
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
    print(json.dumps({"error": "no piece"}))
    sys.exit(1)
pm = (lab == best).astype(np.uint8)
filled = cv2.morphologyEx(pm, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
inv = 1 - filled
inv_p = cv2.copyMakeBorder(inv, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=1)
mf = np.zeros((inv_p.shape[0] + 2, inv_p.shape[1] + 2), np.uint8)
cv2.floodFill(inv_p, mf, (0, 0), 0)
solid = inv_p[1:-1, -1:-1] if False else inv_p[1:-1, 1:-1].astype(np.uint8)
if solid.sum() < 30:
    solid = filled
cnts, _ = cv2.findContours(solid, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
pcnt = max(cnts, key=cv2.contourArea)
pb = cv2.boundingRect(pcnt)
cx, cy = pb[0] + pb[2] / 2, pb[1] + pb[3] / 2
print(f"piece box={pb} center=({cx:.0f},{cy:.0f}) area={cv2.contourArea(pcnt):.0f}")

# dilated silhouette = stroke band (the hole outline traces this curve)
pb = cv2.boundingRect(pcnt)
pad = 4
x0, y0 = max(0, pb[0] - pad), max(0, pb[1] - pad)
x1, y1 = min(W, pb[0] + pb[2] + pad), min(H, pb[1] + pb[3] + pad)
solid = solid[y0:y1, x0:x1]
tmpl = cv2.dilate(solid, np.ones((5, 5), np.uint8))
th, tw = tmpl.shape
if tw >= W or th >= H:
    print(json.dumps({"error": "template bigger than image"}))
    sys.exit(1)
tmpl_f = tmpl.astype(np.float32)
tmpl_f /= tmpl_f.sum()

# --- anomaly maps -----------------------------------------------------------
white = ((gray > 70) & (r > 50) & (g > 50)).astype(np.uint8)
blue_px = blue.astype(np.uint8)
valid = ((white > 0) & (blue_px == 0)).astype(np.float32)   # dash pixels only

def norm(x):
    s = x.std()
    return (x - x.mean()) / max(s, 1e-6)

# density anomaly: local dash density minus its own blurred version
dens = cv2.GaussianBlur(valid, (0, 0), 12)
dens_res = norm(dens - cv2.GaussianBlur(dens, (0, 0), 25))

# tone anomaly: local lightness deviation from a wide blur
light = cv2.GaussianBlur(gray, (0, 0), 2)            # kill dash specks first
light_res = norm(light - cv2.GaussianBlur(light, (0, 0), 25))

# dash-brightness anomaly: brightness of the dashes themselves
dash_bright = cv2.GaussianBlur(gray * valid, (0, 0), 6) / np.maximum(cv2.GaussianBlur(valid, (0, 0), 6), 1e-3)
dash_res = norm(np.nan_to_num(dash_bright))

maps = {'density': dens_res, 'tone': light_res, 'dashbright': dash_res}

results = {}
for name, M in maps.items():
    for sign, tag in ((1, 'high'), (-1, 'low')):
        score = cv2.matchTemplate((sign * M).astype(np.float32), tmpl_f, cv2.TM_CCORR)
        # ignore peaks whose window overlaps the piece itself
        px0, py0 = max(0, int(pb[0] - tw)), max(0, int(pb[1] - th))
        score[max(0, int(pb[1] - th)):min(score.shape[0], int(pb[1] + pb[3] + th)),
              max(0, int(pb[0] - tw)):min(score.shape[1], int(pb[0] + pb[2] + tw))] = -1e9
        flat = np.argsort(score.ravel())[::-1][:6]
        peaks = []
        used = []
        for idx in flat:
            y, x = divmod(int(idx), score.shape[1])
            if any(abs(x - ux) < tw * 0.6 and abs(y - uy) < th * 0.6 for ux, uy in used):
                continue
            used.append((x, y))
            peaks.append({'x': int(x + tw / 2), 'y': int(y + th / 2),
                          'score': round(float(score[y, x]), 3),
                          'w': int(tw), 'h': int(th)})
        results[f'{name}_{tag}'] = peaks

print(json.dumps(results, indent=1))

# overlay: best peak per map
ov = cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)
colors = {'density_high': (0, 255, 255), 'tone_high': (0, 255, 0),
          'tone_low': (255, 0, 255), 'dashbright_high': (0, 128, 255),
          'density_low': (255, 255, 0), 'dashbright_low': (255, 128, 0)}
for k, peaks in results.items():
    if not peaks:
        continue
    p = peaks[0]
    col = colors.get(k, (200, 200, 200))
    x, y, w, h = p['x'] - tw // 2, p['y'] - th // 2, tw, th
    cv2.rectangle(ov, (x, y), (x + w, y + h), col, 1)
    cv2.putText(ov, f"{k}:{p['score']}", (x + 2, max(10, y - 3)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.35, col, 1, cv2.LINE_AA)
cv2.rectangle(ov, (pb[0], pb[1]), (pb[0] + pb[2], pb[1] + pb[3]), (0, 255, 255), 2)
cv2.imwrite(f'{out_prefix}-ov.png', ov)
print('wrote', f'{out_prefix}-ov.png')
