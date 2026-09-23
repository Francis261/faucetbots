#!/usr/bin/env python3
"""Find blue piece center in OnlyFaucet puzzle PNG. Prints JSON or null."""
import sys, json
from PIL import Image
from collections import deque

def main(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    # Ignore outer border (widget frame is blue)
    m = 6
    mask = [[False]*w for _ in range(h)]
    for y in range(m, h-m):
        for x in range(m, w-m):
            r, g, b = px[x, y]
            if b > 140 and b > r + 50 and g > r + 20 and g > 60:
                mask[y][x] = True
    # Connected components (4-neighbor)
    seen = [[False]*w for _ in range(h)]
    best = None
    for y in range(m, h-m):
        for x in range(m, w-m):
            if not mask[y][x] or seen[y][x]:
                continue
            q = deque([(x, y)])
            seen[y][x] = True
            comp = []
            while q:
                cx, cy = q.popleft()
                comp.append((cx, cy))
                for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                    nx, ny = cx+dx, cy+dy
                    if m <= nx < w-m and m <= ny < h-m and mask[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        q.append((nx, ny))
            if best is None or len(comp) > len(best):
                best = comp
    if not best or len(best) < 12:
        print('null')
        return
    # Reject absurd blobs
    if len(best) > w * h * 0.15:
        print('null')
        return
    xs = sorted(p[0] for p in best)
    ys = sorted(p[1] for p in best)
    # Compact bbox check
    if (xs[-1]-xs[0]+1) > w*0.7 or (ys[-1]-ys[0]+1) > h*0.7:
        print('null')
        return
    cx = xs[len(xs)//2]
    cy = ys[len(ys)//2]
    print(json.dumps({
        "pieceX": cx, "pieceY": cy, "w": w, "h": h, "n": len(best),
        "x0": xs[0], "x1": xs[-1], "y0": ys[0], "y1": ys[-1],
    }))

if __name__ == '__main__':
    main(sys.argv[1])
