#!/usr/bin/env python3
"""MoonPTC rotation-captcha angle solver.

The captcha draws the base image, then draws the challenge "variant" image
(pre-rotated base crop) inside a circle clip, rotated by the slider angle T
(canvas rotate(T), y-down coords).  We brute-force T in 0..359 and pick the
angle whose rendered pixels best match the underlying base image.

Server accepts answers within +-10 degrees (tolerance in challenge payload),
so we only need the matching peak, not exact equality.

Usage: solver.py <base.webp> <variant.webp> <crop_json>   # -> prints angle
"""
import json
import math
import sys

import numpy as np
from PIL import Image


def bilinear(img, u, v):
    """Sample img (H,W,C float32) at float coords u (x/col), v (y/row)."""
    h, w = img.shape[:2]
    u = np.clip(u, 0, w - 1.001)
    v = np.clip(v, 0, h - 1.001)
    u0 = u.astype(np.int32)
    v0 = v.astype(np.int32)
    fu = (u - u0)[..., None]
    fv = (v - v0)[..., None]
    top = img[v0, u0] * (1 - fu) + img[v0, u0 + 1] * fu
    bot = img[v0 + 1, u0] * (1 - fu) + img[v0 + 1, u0 + 1] * fu
    return top * (1 - fv) + bot * fv


def solve(base_path, variant_path, crop):
    base = np.asarray(Image.open(base_path).convert("RGB"), dtype=np.float32)
    var_img = Image.open(variant_path).convert("RGBA")
    var = np.asarray(var_img, dtype=np.float32)
    vh, vw = var.shape[:2]
    var_rgb = var[:, :, :3]
    var_a = var[:, :, 3] / 255.0

    c = base.shape[1]              # canvas px = base image width
    cx, cy = crop["x"] * c, crop["y"] * c
    r = crop["radius"] * c

    margin = max(3.0, r * 0.06)    # stay inside the drawn ring / blend edge
    span = int(2 * r) + 2
    ys, xs = np.mgrid[0:span, 0:span].astype(np.float32)
    dx = xs - r
    dy = ys - r
    inside = np.sqrt(dx * dx + dy * dy) < (r - margin)
    dxm = dx[inside]
    dym = dy[inside]

    px = np.clip(np.round(cx + dxm).astype(np.int32), 0, base.shape[1] - 1)
    py = np.clip(np.round(cy + dym).astype(np.int32), 0, base.shape[0] - 1)
    target = base[py, px]                      # (N,3)

    mses = np.empty(360, dtype=np.float64)
    for deg in range(360):
        th = math.radians(deg)
        ct, st = math.cos(th), math.sin(th)
        # dest p -> image offset q = R(-T) p ; i = qx + r, j = qy + r
        qx = ct * dxm + st * dym
        qy = -st * dxm + ct * dym
        u = (qx + r) / (2 * r) * (vw - 1)
        v = (qy + r) / (2 * r) * (vh - 1)
        sample = bilinear(var_rgb, u, v)
        a = bilinear(var_a[..., None], u, v)[..., 0]
        valid = a > 0.5
        diff = sample[valid] - target[valid]
        mses[deg] = float(np.mean(diff * diff))

    best = int(np.argmin(mses))
    # sharpness: best vs mean of all angles, and vs the worst local rival
    ranked = np.sort(mses)
    return {
        "angle": best,
        "mse": float(mses[best]),
        "mse_median": float(np.median(mses)),
        "second_best_mse": float(ranked[1]),
        "within_tolerance": int(np.sum(mses <= mses[best] * 1.10 + 1e-9)),
    }


if __name__ == "__main__":
    base_p, var_p = sys.argv[1], sys.argv[2]
    crop = json.loads(sys.argv[3])
    print(json.dumps(solve(base_p, var_p, crop)))
