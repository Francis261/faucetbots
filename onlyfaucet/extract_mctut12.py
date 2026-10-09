#!/usr/bin/env python3
"""Extract the official v6 tutorial battery from onlyfaucet.com/mcaptchav6.html.

Usage:
  python3 extract_mctut12.py [path/to/mcaptchav6.html] [out_dir]

Writes <out>/v6NN-scene.png, v6NN-ref.png and mctut12.json (zones/near/hint/trap
per example) into out (default v6/mctut12).
"""
import base64
import json
import os
import sys
import urllib.request

import cv2
import numpy as np

URL = "https://onlyfaucet.com/mcaptchav6.html"


def load_html(path=None):
    if path and os.path.exists(path):
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    with urllib.request.urlopen(URL, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def extract_R(html):
    """Parse the `var R = [...]` array of examples (scene/ref base64 + labels)."""
    key = "var R = ["
    i = html.index(key) + len("var R = ")
    R, _ = json.JSONDecoder().raw_decode(html[i:])
    return R


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "v6", "mctut12")
    os.makedirs(out, exist_ok=True)
    R = extract_R(load_html(src))
    assert len(R) == 12, f"expected 12 examples, got {len(R)}"
    labels = []
    for i, e in enumerate(R):
        assert set(e) >= {"scene", "ref", "zones", "near", "hint", "trap"}, set(e)
        assert len(e["zones"]) == 2 and len(e["near"]) == 2 and len(e["hint"]) == 4
        assert len(e["trap"]) == 2, "trap must align with near"
        for key in ("scene", "ref"):
            buf = np.frombuffer(base64.b64decode(e[key].split(",", 1)[1]), np.uint8)
            img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
            assert img is not None, (i, key)
            cv2.imwrite(os.path.join(out, f"v6{i:02d}-{key}.png"), img)
        labels.append({k: e[k] for k in ("zones", "near", "hint", "trap")})
    with open(os.path.join(out, "mctut12.json"), "w") as f:
        json.dump(labels, f, indent=1)
    print(f"extracted {len(R)} examples -> {out}")


if __name__ == "__main__":
    main()
