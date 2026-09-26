#!/usr/bin/env python3
"""Enhance an OnlyFaucet puzzle shot so the hidden hole silhouette is visible.

Outputs, next to the input PNG:
  <name>-density.png  : local white-dash density, contrast stretched
  <name>-anom.png     : density minus global mean, signed, stretched
  <name>-overlay.png  : anomaly map with piece contour (blue) marked
"""
import sys, os
import cv2
import numpy as np
from PIL import Image

path = sys.argv[1]
sigma = float(sys.argv[2]) if len(sys.argv) > 2 else 9.0

im = Image.open(path).convert('RGB')
a = np.asarray(im).astype(np.int16)
r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
gray = (0.299 * r + 0.587 * g + 0.114 * b).astype(np.uint8)

blue = ((b > 140) & (b > r + 50) & (g > r + 20) & (g > 60)).astype(np.uint8)
white = ((gray > 70) & (r > 50) & (g > 50) & (blue == 0)).astype(np.uint8)

dens = cv2.GaussianBlur(white.astype(np.float32), (0, 0), sigmaX=sigma, sigmaY=sigma)
print(f"size={im.size} white_px={int(white.sum())} dens mean={dens.mean():.4f} std={dens.std():.4f}")

base = os.path.splitext(path)[0]

# 1) density contrast-stretched
lo, hi = np.percentile(dens, 1), np.percentile(dens, 99)
dn = np.clip((dens - lo) / max(hi - lo, 1e-6), 0, 1)
cv2.imwrite(f'{base}-density.png', (dn * 255).astype(np.uint8))

# 2) anomaly (signed) around local mean, normalized
med = cv2.medianBlur((dens * 200).astype(np.uint8), 31).astype(np.float32) / 200
anom = dens - med
s = np.abs(anom).std()
an = np.clip(anom / (3 * max(s, 1e-6)) * 0.5 + 0.5, 0, 1)
cv2.imwrite(f'{base}-anom.png', (an * 255).astype(np.uint8))

# 3) overlay anomaly with blue piece contour
ov = cv2.cvtColor((an * 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)
n, lab, st, _ = cv2.connectedComponentsWithStats(blue, 8)
best, best_a = -1, -1
for i in range(1, n):
    if st[i, 4] > best_a and 120 < st[i, 4] < a.shape[0] * a.shape[1] * 0.15:
        best, best_a = i, st[i, 4]
if best >= 0:
    m = (lab == best).astype(np.uint8)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(ov, cnts, -1, (0, 255, 255), 2)
cv2.imwrite(f'{base}-overlay.png', ov)

# Report top anomaly blobs (candidate hole centres)
blob = (np.abs(anom) > 2.0 * max(s, 1e-6)).astype(np.uint8)
blob = cv2.morphologyEx(blob, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
n, lab, st, _ = cv2.connectedComponentsWithStats(blob, 8)
rows = []
for i in range(1, n):
    x, y, w, h, area = st[i]
    if area < 60 or w < 12 or h < 12:
        continue
    rows.append((area, int(x + w / 2), int(y + h / 2), int(w), int(h)))
rows.sort(reverse=True)
print("top anomaly blobs (area, cx, cy, w, h):", rows[:8])
print("wrote:", f'{base}-density.png', f'{base}-anom.png', f'{base}-overlay.png')
