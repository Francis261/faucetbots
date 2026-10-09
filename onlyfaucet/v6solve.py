#!/usr/bin/env python3
"""v6solve.py — v6 CAPTCHA solver ("Find its twins", 4 part categories).

v6 semantics (see v6study.md, source mcaptchav6.html):
  - all monsters share the same body; only 4 part categories count:
    top / arms / legs / wings (closed vocabularies below, kind+count matter);
  - colour, pattern, face, size, lean, wing angle, background are irrelevant
    and the faces are always different on purpose;
  - every scene has exactly 2 twins plus 2 one-part-off look-alikes.

Signals (same proven shape as v5solve; temp=0, ollama.com gemma4:31b):
  B  : absolute 4-category classify of ref + every cell (one grid call)
  E  : ref vs every cell, 4-char S/D string per cell (E_SAMPLES=3, majority)
  E2 : same as E with shuffled cell order
  P2 : pairwise ref|cand side-by-side, sides swapped (one call per candidate)

RULE = safe-union: maj2(B, E, P2) OR maj2(B, E2, P2), then dedupe(20px).
Battery: eval_mctut6.py over v6/mctut12 (strict exact-set of 2).
"""
import json, math, os, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
import cand_v5
from eval_cv5 import ref_crop, b64img, dedupe, CELL, COLS   # noqa: E402
from exp_v5 import ask, big_ref                             # noqa: E402

# closed vocabularies from the official tutorial (v6study.md)
VOCAB = {
    'top':   ['pointy ears', 'long bunny ears', 'a spiky mohawk', 'one horn',
              'a propeller', 'a little sprout', 'antennae', 'nothing on top'],
    'arms':  ['arms with claws', 'long arms with hands', 'tentacle arms',
              'crab pincers', 'no arms'],
    'legs':  ['four little feet', 'two feet', 'long legs', 'spring legs',
              'tentacle legs', 'no legs'],
    'wings': ['butterfly wings', 'bat wings', 'dragonfly wings', 'no wings'],
}
SLOT_ORDER = ('top', 'arms', 'legs', 'wings')

# segmentation noise filter (v6study.md: labeled monsters area>=830 edge>=0.117;
# flat background splashes have ~zero Canny edges)
MIN_AREA6, EDGE_T6 = 600, 0.08
CROP_M6 = 0.28            # cand crop margin: keeps limbs/parts inside the cell

IGNORE = ("IGNORE colour, colour pattern, face (eyes and mouth), size, slight lean, "
          "pose, rotation, wing angle and background. The face is ALWAYS different "
          "from the reference on purpose — never use it.")

PROMPT_B6 = """Image 1 = REFERENCE monster (a cut-out of exactly one cartoon monster).
Image 2 = grid of numbered cells; each cell is a tight crop around ONE candidate from a scene. The cell's 1-based index is drawn in its top-left corner.

TASK
1. Classify the REFERENCE monster (Image 1).
2. Classify the main monster centered in EACH cell of Image 2.

All monsters share the same body — the body NEVER distinguishes them. Judge ONLY these 4 part categories, using EXACTLY one value from each list (copy the strings verbatim):
- top: pointy ears | long bunny ears | a spiky mohawk | one horn | a propeller | a little sprout | antennae | nothing on top
- arms: arms with claws | long arms with hands | tentacle arms | crab pincers | no arms
- legs: four little feet | two feet | long legs | spring legs | tentacle legs | no legs
- wings: butterfly wings | bat wings | dragonfly wings | no wings

RULES
- KIND and COUNT matter: two horns vs one horn, four little feet vs two feet are different parts.
- IGNORE colour, colour pattern, face (eyes and mouth), size, slight lean, pose, rotation, wing angle and background. The face is ALWAYS different from the reference on purpose — never use it.
- A cell that shows only a fragment (part of a monster cut off, e.g. only wings or only legs), or debris/background with no complete monster centered, must be "incomplete".
- Do not let other monsters partially visible at cell edges influence the classification of the centered monster.

Reply with ONLY a JSON object, no other text, in exactly this shape:
{"ref":{"top":"...","arms":"...","legs":"...","wings":"..."},"cells":{"1":{"top":"...","arms":"...","legs":"...","wings":"..."},"2":"incomplete", ...}}
Include EVERY cell index from 1 up to the highest number shown."""

PROMPT_E6 = """Image 1 = REFERENCE monster (one cartoon monster cut-out).
Image 2 = grid of numbered cells; each cell is a tight crop centered on ONE candidate from a scene (index drawn top-left).

For EACH cell compare its centered monster with the reference monster, CATEGORY BY CATEGORY.
Categories in order: top, arms, legs, wings.

Output a 4-character string per cell using:
  S = this category is the SAME as the reference (same kind and count)
  D = this category DIFFERS from the reference
  X = cell is incomplete (only a fragment of a monster, or debris/background, no complete monster centered)

Examples: "SSSS" = identical parts. "SSDS" = legs differ.

What counts per category:
- top: whatever is on the head (pointy ears / long bunny ears / spiky mohawk / one horn / propeller / little sprout / antennae / nothing on top). Kind and count matter: two horns vs one horn differ.
- arms: the arms (arms with claws / long arms with hands / tentacle arms / crab pincers / no arms).
- legs: the legs (four little feet / two feet / long legs / spring legs / tentacle legs / no legs). Four feet vs two feet differ.
- wings: the wings on the back (butterfly wings / bat wings / dragonfly wings / no wings).

The body is the same on every monster — never judge it.
IGNORE colour, colour pattern, face (eyes and mouth), size, slight lean, pose, rotation, wing angle and background. The face is ALWAYS different from the reference on purpose — never use it.

Reply ONLY JSON: {"cells":{"1":"SSSS","2":"X","3":"DSSS",...}}
Include EVERY cell index 1..N exactly once."""

PROMPT_P6 = """Image shows TWO cartoon monsters side by side.
LEFT = the REFERENCE monster. RIGHT = the CANDIDATE monster.

Compare them category by category: are the parts the same?
Categories in order [top, arms, legs, wings]:
- top: what's on the head (pointy ears / long bunny ears / spiky mohawk / one horn / propeller / little sprout / antennae / nothing on top). Kind and count matter: two horns vs one horn differ.
- arms: arms with claws / long arms with hands / tentacle arms / crab pincers / no arms.
- legs: four little feet / two feet / long legs / spring legs / tentacle legs / no legs. Four feet vs two feet differ.
- wings: butterfly wings / bat wings / dragonfly wings / no wings.

The body is the same on every monster — never judge it.
IGNORE colour, colour pattern, face (eyes and mouth), size, slight lean, pose, rotation, wing angle and background. The face is ALWAYS different from the reference on purpose — never use it.
If the candidate is cut off, a fragment, or background (no complete monster), still reply with the JSON: answer D for every category you cannot confirm to be the same. Never refuse and never omit the JSON.

Reply ONLY JSON: {"slots":"...."} with exactly 4 chars: S = same parts in that category, D = differs."""

PROMPT_P6_2 = PROMPT_P6.replace(
    'LEFT = the REFERENCE monster. RIGHT = the CANDIDATE monster.',
    'LEFT = the CANDIDATE monster. RIGHT = the REFERENCE monster.')


# ---------------------------------------------------------------- helpers

def norm4(obj):
    """Return normalized {top,arms,legs,wings} dict or None if invalid."""
    if not isinstance(obj, dict):
        return None
    out = {}
    for k in SLOT_ORDER:
        v = str(obj.get(k, '')).strip().lower().rstrip('.')
        if v not in [x.lower() for x in VOCAB[k]]:
            return None
        out[k] = v
    return out


def _slots4(p):
    s = (p or {}).get('slots')
    if isinstance(s, str):
        s = s.replace(' ', '')
        if len(s) == 4 and not set(s) - set('SD'):
            return s
    return None


def seg6(scene):
    """cand_v5 + v6 noise filter (flat splashes, tiny fragments)."""
    cands, mask, mode = cand_v5.candidates(scene)
    gray = cv2.cvtColor(scene, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 60, 160)
    keep = []
    for c in cands:
        x, y, w, h = c['x'], c['y'], c['w'], c['h']
        ef = float((edges[y:y + h, x:x + w] > 0).sum()) / max(1, w * h)
        if c['area'] >= MIN_AREA6 and ef >= EDGE_T6:
            keep.append(c)
    return keep, mask, mode


def fit_crop(crop, cell=CELL, up_cap=4.0):
    h, w = crop.shape[:2]
    scale = min(cell / w, cell / h, up_cap)
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    interp = cv2.INTER_CUBIC if scale > 1.05 else cv2.INTER_AREA
    im = Image.fromarray(cv2.cvtColor(cv2.resize(crop, (nw, nh), interpolation=interp),
                                      cv2.COLOR_BGR2RGB))
    out = Image.new('RGB', (cell, cell), (250, 250, 250))
    out.paste(im, ((cell - nw) // 2, (cell - nh) // 2))
    return out


def cand_crop6(scene, c, cell=CELL):
    """Tight crop around a candidate's bbox with a generous margin so split
    limbs (legs/wings below or beside the body component) stay visible."""
    H, W = scene.shape[:2]
    mx = int(c['w'] * CROP_M6) + 8
    my = int(c['h'] * CROP_M6) + 8
    x0, y0 = max(0, c['x'] - mx), max(0, c['y'] - my)
    x1, y1 = min(W, c['x'] + c['w'] + mx), min(H, c['y'] + c['h'] + my)
    return fit_crop(scene[y0:y1, x0:x1], cell)


def _label_cell(draw, ox, oy, label, font):
    tw = draw.textlength(label, font=font)
    draw.rectangle([ox + 4, oy + 4, ox + 14 + tw, oy + 42],
                   fill=(255, 255, 255), outline=(0, 0, 0), width=2)
    draw.text((ox + 9, oy + 7), label, fill=(200, 0, 0), font=font)
    draw.rectangle([ox, oy, ox + CELL - 1, oy + CELL - 1], outline=(110, 110, 110))


def build_grid6(scene, cands, order=None):
    """Numbered grid; order (optional) permutes placement, labels stay 1-based."""
    n = len(cands)
    rows = (n + COLS - 1) // COLS
    grid = Image.new('RGB', (COLS * CELL, rows * CELL), (255, 255, 255))
    draw = ImageDraw.Draw(grid)
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 28)
    except Exception:
        font = ImageFont.load_default()
    for pos, j in enumerate(range(n) if order is None else order):
        col, row = pos % COLS, pos // COLS
        ox, oy = col * CELL, row * CELL
        grid.paste(cand_crop6(scene, cands[j]), (ox, oy))
        _label_cell(draw, ox, oy, str(j + 1), font)
    return grid


def pair_image6(scene, cands, ref, j, swap=False):
    """ref|cand (or cand|ref) side by side at 210x186 each."""
    PAIR_W, PAIR_H = 210, 186
    ref_img = cv2.resize(big_ref(ref, PAIR_H), (PAIR_W, PAIR_H), interpolation=cv2.INTER_AREA)
    cand = cv2.cvtColor(np.array(cand_crop6(scene, cands[j], cell=PAIR_H)), cv2.COLOR_RGB2BGR)
    cand_img = cv2.resize(cand, (PAIR_W, PAIR_H), interpolation=cv2.INTER_AREA)
    left, right = (cand_img, ref_img) if swap else (ref_img, cand_img)
    pair = np.full((PAIR_H, 2 * PAIR_W + 8, 3), 255, np.uint8)
    pair[:, :PAIR_W] = left
    pair[:, PAIR_W + 8:] = right
    return Image.fromarray(cv2.cvtColor(pair, cv2.COLOR_BGR2RGB))


# ---------------------------------------------------------------- rules

def _maj(vs, need, n):
    if any(s is None for s in vs):
        return None
    return {j for j in range(n) if sum(j in s for s in vs) >= need}


def _safe_union(v, n):
    a = _maj([v.get('B'), v.get('E'), v.get('P2')], 2, n)
    b = _maj([v.get('B'), v.get('E2'), v.get('P2')], 2, n)
    if a is None or b is None:
        return None
    return a | b


def _safe_union_cap2(v, n):
    """v6 twist on v5's cap4: an answer of exactly 2 is forced by the site, so
    when safe-union proposes >=3 cells fall back to the intersection (core)."""
    su = _safe_union(v, n)
    if su is None or len(su) < 3:
        return su
    a = _maj([v.get('B'), v.get('E'), v.get('P2')], 2, n)
    b = _maj([v.get('B'), v.get('E2'), v.get('P2')], 2, n)
    core = a & b
    print(f'v6solve: cap2-engaged su={sorted(su)} -> core={sorted(core)}',
          file=sys.stderr, flush=True)
    return core


def _solo(v, k, n):
    s = v.get(k)
    return None if s is None else set(s)


RULES = {
    'B':                (lambda v, n: _solo(v, 'B', n),        ('B',)),
    'E':                (lambda v, n: _solo(v, 'E', n),        ('E',)),
    'P2':               (lambda v, n: _solo(v, 'P2', n),       ('P2',)),
    'maj3(B,E,P2)':     (lambda v, n: _maj([v['B'], v['E'], v['P2']], 2, n),
                         ('B', 'E', 'P2')),
    'safe-union':       (_safe_union,     ('B', 'E', 'E2', 'P2')),
    'safe-union-cap2':  (_safe_union_cap2, ('B', 'E', 'E2', 'P2')),
}
DEFAULT_RULE = 'safe-union'
E_SAMPLES = 3

_pause_until = 0.0        # global cooldown after HTTP 429
_pause_lock = __import__('threading').Lock()


def _ask(prompt, images, max_tokens=2600, tries=4, valid=None):
    """Same retrying wrapper as v5solve (429 global pause, exponential backoff)."""
    import time as _t
    import urllib.error as _ue
    global _pause_until
    last = None
    for k in range(tries):
        while True:
            wait = _pause_until - _t.time()
            if wait <= 0:
                break
            _t.sleep(min(wait, 1.0))
        try:
            parsed, raw, ms = ask(prompt, images, max_tokens=max_tokens)
            if parsed is None or (valid is not None and not valid(parsed)):
                last = ValueError(f'bad payload: {raw[:80]}')
            else:
                return parsed, raw, ms
        except _ue.HTTPError as e:
            last = e
            if e.code == 429:
                with _pause_lock:
                    _pause_until = max(_pause_until, _t.time() + 4.0)
        except Exception as e:
            last = e
        print(f'v6solve: _ask try {k + 1}/{tries} failed: '
              f'{type(last).__name__}: {str(last)[:200]}', file=sys.stderr)
        if k + 1 < tries:
            _t.sleep(min(8.0, 1.5 * (2 ** k)))
    raise last


# ---------------------------------------------------------------- signals

def _sig_B(ref, scene, cands):
    parsed, raw, ms = _ask(PROMPT_B6, [b64img(ref_crop(ref)),
                                       b64img(build_grid6(scene, cands))],
                           max_tokens=2600,
                           valid=lambda p: norm4(p.get('ref')) is not None)
    rslots = norm4(parsed.get('ref'))
    if rslots is None:
        return 'B', None, ms, None, None
    cells = parsed.get('cells') or {}
    out = set()
    cell_parts = {}
    for j in range(len(cands)):
        v = cells.get(str(j + 1), cells.get(j + 1))
        f = norm4(v)
        cell_parts[j] = f if f is not None else ('incomplete' if v == 'incomplete' else None)
        if f is not None and f == rslots:
            out.add(j)
    return 'B', out, ms, rslots, cell_parts


def _sig_E(ref, scene, cands, tag='E', shuffled_order=None):
    grid = build_grid6(scene, cands) if shuffled_order is None \
        else build_grid6(scene, cands, order=shuffled_order)
    parsed, raw, ms = _ask(PROMPT_E6, [b64img(ref_crop(ref)), b64img(grid)],
                           valid=lambda p: isinstance(p.get('cells'), dict))
    cells = parsed.get('cells') or {}
    out = set()
    for j in range(len(cands)):
        s = cells.get(str(j + 1), cells.get(j + 1))
        if isinstance(s, str):
            s = s.replace(' ', '')
            if len(s) == 4 and set(s) == {'S'}:
                out.add(j)
    return tag, out, ms


def _sig_P2(j, ref, scene, cands):
    img = pair_image6(scene, cands, ref, j, swap=True)
    parsed, raw, ms = _ask(PROMPT_P6_2, [b64img(img)], max_tokens=60,
                           valid=lambda p: _slots4(p) is not None)
    return 'P2', j, _slots4(parsed), ms


# ---------------------------------------------------------------- solver

def solve(scene, ref, rule=DEFAULT_RULE, workers=6, budget_s=None):
    """Returns dict: ok, taps [(x,y)...], verdict {signal: set|None}, ms."""
    t0 = time.time()
    cands, mask, mode = seg6(scene)
    n = len(cands)
    seg_ms = int((time.time() - t0) * 1000)
    fn, need = RULES[rule]
    verdict = {k: None for k in need}
    slots = {k: {} for k in need if k in ('P', 'P2')}
    b_diag = {'ref': None, 'cells': None}
    rng_order = None
    if 'E2' in need and n:
        rng_order = np.random.default_rng().permutation(n).tolist()

    t1 = time.time()
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        futs = []
        if 'B' in need:
            futs.append(pool.submit(_sig_B, ref, scene, cands))
        if 'E' in need:
            for k in range(E_SAMPLES):
                futs.append(pool.submit(_sig_E, ref, scene, cands, f'e{k}', None))
        if 'E2' in need:
            futs.append(pool.submit(_sig_E, ref, scene, cands, 'E2', rng_order))
        for j in range(n):
            if 'P2' in need:
                futs.append(pool.submit(_sig_P2, j, ref, scene, cands))
        grid = {}
        pending = list(futs)

        def _collect(r):
            if r is None:
                return
            if len(r) == 3:
                tag, s, _ms = r
                grid[tag] = s
            elif len(r) == 5:                     # B with classification diagnostics
                tag, s, _ms, rp, cp = r
                grid[tag] = s
                b_diag['ref'], b_diag['cells'] = rp, cp
            else:
                tag, j, s, _ms = r
                slots[tag][j] = s

        deadline_hit = False
        try:
            for fu in as_completed(futs, timeout=budget_s):
                pending.remove(fu)
                try:
                    r = fu.result()
                except Exception:
                    r = None
                _collect(r)
        except TimeoutError:
            deadline_hit = True
        for fu in pending[:]:
            if fu.done() and not fu.cancelled():
                pending.remove(fu)
                try:
                    r = fu.result()
                except Exception:
                    r = None
                _collect(r)
        for fu in pending:
            fu.cancel()
        if deadline_hit:
            print(f'v6solve: vlm budget {budget_s}s hit — '
                  f'{len(pending)} straggler(s) dropped', file=sys.stderr)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    if 'B' in need:
        verdict['B'] = grid.get('B')
    if 'E2' in need:
        verdict['E2'] = grid.get('E2')
    if 'E' in need:
        usable = [grid.get(f'e{k}') for k in range(E_SAMPLES)]
        usable = [s for s in usable if s is not None]
        if not usable:
            verdict['E'] = None
        else:
            thr = len(usable) // 2 + 1
            verdict['E'] = {j for j in range(n)
                            if sum(j in s for s in usable) >= thr}
    failed_cells = 0
    for tag in slots:
        vals = slots[tag]
        if not vals:
            verdict[tag] = None
        else:
            failed_cells += n - len(vals)
            verdict[tag] = {j for j, v in vals.items() if v == 'SSSS'}
    vms = int((time.time() - t1) * 1000)

    matched = fn(verdict, n)
    diag = {'ref_parts': b_diag['ref'], 'cell_parts': b_diag['cells'],
            'p2_slots': {str(j): s for j, s in slots.get('P2', {}).items()}}
    if matched is None:
        missing = [k for k in need if verdict.get(k) is None]
        return {'ok': False, 'reason': f'signal-missing({",".join(missing)})',
                'verdict': verdict, 'deadline_hit': deadline_hit,
                'n': n, 'seg_ms': seg_ms, 'vlm_ms': vms, **diag}
    kept = dedupe(matched, cands)
    taps = [(int(c['cx']), int(c['cy'])) for c in kept]
    return {'ok': True, 'taps': taps, 'n': n, 'matched': sorted(matched),
            'verdict': verdict, 'seg_ms': seg_ms, 'vlm_ms': vms,
            'failed_cells': failed_cells, 'deadline_hit': deadline_hit, **diag}


def main():
    if len(sys.argv) >= 4 and sys.argv[1] == '--files':
        scene = cv2.imread(sys.argv[2])
        ref = cv2.imread(sys.argv[3])
        if scene is None or ref is None:
            print(json.dumps({'ok': False, 'reason': 'unreadable-image'}))
            return
        rule = sys.argv[4] if len(sys.argv) > 4 else DEFAULT_RULE
        try:
            t0 = time.time()
            res = solve(scene, ref, rule=rule, budget_s=34)
            res['wall_ms'] = int((time.time() - t0) * 1000)
        except Exception as e:
            res = {'ok': False, 'reason': f'exception: {e}'}
        res['verdict'] = {k: (sorted(s) if isinstance(s, set) else s)
                          for k, s in (res.get('verdict') or {}).items()}
        print(json.dumps(res), flush=True)
        if res.get('deadline_hit'):
            sys.stdout.flush()
            os._exit(0)
        return
    i = int(sys.argv[1])
    rule = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_RULE
    scene = cv2.imread(str(Path(__file__).parent / 'v6' / 'mctut12' / f'v6{i:02d}-scene.png'))
    ref = cv2.imread(str(Path(__file__).parent / 'v6' / 'mctut12' / f'v6{i:02d}-ref.png'))
    t0 = time.time()
    res = solve(scene, ref, rule=rule)
    res['wall_ms'] = int((time.time() - t0) * 1000)
    res['verdict'] = {k: (sorted(s) if isinstance(s, set) else s)
                      for k, s in (res.get('verdict') or {}).items()}
    print(json.dumps(res, indent=1))


if __name__ == '__main__':
    main()
