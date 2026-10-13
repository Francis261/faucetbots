#!/usr/bin/env python3
"""v7solve.py — v7 CAPTCHA solver (12 task types, mcaptchav7.html).

v7 semantics (v7study.md):
  - every card states ONE task ("Tap the 2 with {YELLOW WORDS}"), exactly 2 right;
  - hint picture (150x110) = reference monster for twins/wings/missing/extra,
    meaning illustration for the other 8 tasks;
  - scene 450x280, 8 monsters in a clean 2x4 grid -> 8 blocks of 112x140.

Task families:
  ref      twins, wings, missing, extra      -> 4-cat classification vs hint (B7)
  presence no-wings, arms-legs               -> 4-cat classification (B7)
  detail   2-eyes, stripes, upside-down,
           side, body-shape                  -> structured per-cell calls (C)
  size     biggest-smallest                  -> global scene call only

Signals (block-level sets, 8 blocks):
  G0,G1 : full scene with drawn 1..8 position labels + hint -> {"match":[...]}
          (global context: size, majority shape, orientation all preserved)
  B7    : one grid call classifying cells (+ hint as ref) with the v6 4-cat vocab
  C     : per tight-crop structured judgment (detail family)

RULES combine block sets; live guard (bot): exactly 2 taps (nT===2) before Verify.
"""
import json, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
from v6solve import (seg6, cand_crop6, build_grid6, _ask,  # noqa: E402
                     SLOT_ORDER, norm4, _maj)
from eval_cv5 import b64img, CELL  # noqa: E402

# ---------------------------------------------------------------- tasks

FAMILY = {
    'twins': 'ref', 'wings': 'ref', 'missing': 'ref', 'extra': 'ref',
    'no-wings': 'presence', 'arms-legs': 'presence', 'arms-wings': 'presence',
    '2-eyes': 'detail', 'stripes': 'detail', 'upside-down': 'detail',
    'side': 'detail', 'body-shape': 'detail',
    'biggest-smallest': 'size',
}

HINT_TITLES = {
    'twins':      'Tap the 2 monsters that are TWINS of the reference monster (all 4 parts equal: top, arms, legs, wings).',
    'wings':      'Tap the 2 monsters with the SAME KIND OF WINGS as the reference monster.',
    'missing':    'Tap the 2 monsters that are copies of the reference with EXACTLY ONE PART MISSING (a part the reference has is gone: no wings / no arms / no legs / nothing on top). Everything else must match the reference.',
    'extra':      'Tap the 2 monsters that are copies of the reference with EXACTLY ONE PART ADDED (the reference does NOT have that part: e.g. reference "nothing on top" vs monster "antennae"). Everything else must match the reference.',
    'no-wings':   'Tap the 2 monsters with NO WINGS (bare back — every other monster in the scene has wings).',
    'arms-legs':  'Tap the 2 monsters that have BOTH arms AND legs (arms at the sides AND legs/feet below the body).',
    'arms-wings': 'Tap the 2 monsters that have BOTH arms AND wings (they have both).',
    '2-eyes':     'Tap the 2 monsters with EXACTLY 2 EYES (count carefully; the other monsters have 1 or 3+ eyes).',
    'stripes':    'Tap the 2 monsters with STRIPES on the body (striped body pattern — the others are plain).',
    'upside-down': 'Tap the 2 monsters standing UPSIDE DOWN (head pointing down, feet/antenna pointing up).',
    'side':       'Tap the 2 monsters LYING ON THEIR SIDE (rotated about 90 degrees — not standing upright and not fully upside down).',
    'biggest-smallest': 'Tap the BIGGEST monster and the SMALLEST monster of the scene (one big, one small).',
    'body-shape': 'Tap the 2 monsters whose BODY SHAPE is different from the other monsters (e.g. round vs rectangular). Judge only the body outline — not parts, colour or face.',
}

# ordered: specific checks BEFORE generic — live 2026-10-12 showed the site
# serves task kinds BEYOND the tutorial's 12 ("Tap the 2 with ARMS and WINGS").
# Anything not recognized must RAISE -> bot bails free (never guess a task).
_PARSE_ORDER = [
    ('no wings', 'no-wings'),
    ('2 eyes', '2-eyes'), ('two eyes', '2-eyes'),
    ('biggest', 'biggest-smallest'),
    ('different body', 'body-shape'),
    ('missing', 'missing'),
    ('extra', 'extra'),
    ('stripes', 'stripes'),
    ('upside', 'upside-down'),
    ('lying', 'side'), ('on their side', 'side'),
]


def parse_task(title, sub=''):
    t = re.sub(r'[{}]', '', (title or '')).lower()
    # combination checks first ('twin' before arms/legs: the twins prompt text
    # itself lists "arms, legs, wings" and would otherwise misparse)
    if 'twin' in t:
        return 'twins'
    if 'arms' in t and 'legs' in t:
        return 'arms-legs'
    if 'arms' in t and 'wings' in t:
        return 'arms-wings'
    if 'same' in t and 'wings' in t:
        return 'wings'
    for key, kind in _PARSE_ORDER:
        if key in t:
            return kind
    raise ValueError(f'unknown task: {title!r}')


# ---------------------------------------------------------------- imaging

BW, BH = 450 // 4, 280 // 2          # block size 112 x 140
N_BLOCKS = 8


def block_of(x, y):
    return min(1, int(y // BH)) * 4 + min(3, int(x // BW))


def label_scene(scene, perm=None):
    """Full scene as PIL with 1..8 position labels drawn at block corners.
    perm (optional): label number drawn at each block (defaults to identity)."""
    im = Image.fromarray(cv2.cvtColor(scene, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)
    except Exception:
        font = ImageFont.load_default()
    for b in range(N_BLOCKS):
        lab = str(b + 1) if perm is None else str(perm[b] + 1)
        ox, oy = (b % 4) * BW + 2, (b // 4) * BH + 2
        draw.rectangle([ox, oy, ox + 30, oy + 30], fill=(255, 255, 255), outline=(0, 0, 0), width=2)
        draw.text((ox + 8, oy + 3), lab, fill=(200, 0, 0), font=font)
    return im


def hint_img(hint):
    return Image.fromarray(cv2.cvtColor(hint, cv2.COLOR_BGR2RGB))


# ---------------------------------------------------------------- prompts

_GUARD = ("ALWAYS reply with the JSON — never refuse, never explain, never omit it. "
          "If unsure, answer anyway. Reply ONLY the JSON object, no other text.")

PROMPT_G7 = """Image 1 = a SCENE of 8 cartoon monsters. Each monster is marked with a number 1-8 in its top-left corner.{pos_note}
Image 2 = the task picture (shows what the task MEANS — an illustration, not a monster to compare parts with).
TASK: {task}

Pick the EXACTLY 2 positions (by the numbers drawn in Image 1) that match the task.
Reply ONLY JSON: {{"match":[<first number>,<second number>]}}.
{guard}"""

PROMPT_B7 = """Image 1 = grid of numbered cells; each cell is a crop of ONE monster from a scene (index drawn top-left).{ref_line}

TASK: {task}

Classify EVERY cell using EXACTLY one value from each list (copy verbatim):
- top: pointy ears | long bunny ears | a spiky mohawk | one horn | a propeller | a little sprout | antennae | nothing on top
- arms: arms with claws | long arms with hands | tentacle arms | crab pincers | no arms
- legs: four little feet | two feet | long legs | spring legs | tentacle legs | no legs
- wings: butterfly wings | bat wings | dragonfly wings | no wings

HOW THE PARTS LOOK (match shape, never colour): top = whatever sits on the head (bare smooth head = nothing on top). arms = the arms at the SIDES. legs = the legs BELOW the body (count feet carefully: four little feet = FOUR small feet incl. tiny rear stubs). wings = wings on the back (bare back = no wings).
{ref_note}IGNORE colour, colour pattern, face, size, lean, pose and background. A cell showing only a fragment or debris (no complete monster) must be "incomplete".
Look specifically at the SIDES (arms) and BELOW the body (legs) — they are easy to miss.

Reply ONLY JSON: {reply}
Include EVERY cell index from 1 up to the highest number shown. {guard}"""

C_HOW = {
    'no-wings':    'Look at its back: wings present (any kind) or none (bare back)? Answer only {"wings":"none"} or {"wings":"present"}.',
    'arms-legs':   'Look at the SIDES for arms and BELOW the body for legs/feet. Answer yes only if you clearly see both: {"arms":"yes"|"no","legs":"yes"|"no"}.',
    '2-eyes':      'COUNT the eyes on the face. Reply {"eyes":<integer>} — the number you see.',
    'stripes':     'Body pattern of the monster in Image 1, EXACTLY one value: '
                   '"striped" = parallel lines, bands or segment divisions running across the body '
                   '(even faint tone-on-tone bands count, like Image 2); '
                   '"spots" = dots/spots/blotches but no parallel lines; '
                   '"plain" = one flat colour with only edge shading or blush; '
                   '"other" = anything else. '
                   'Reply {"pattern":"striped"|"spots"|"plain"|"other"}.',
    'upside-down': 'Compare Image 1 with the pose shown in Image 2. The LEGS/FEET pointing UP (head hanging down) = {"orientation":"upside-down"} — judge by where the legs and feet are, NOT by the face (the face may look normal). Standing normally = "upright"; rotated about 90 degrees = "side"; ambiguous lean = "tilted".',
    'side':        'Compare Image 1 with the pose shown in Image 2. Body axis horizontal / lying rotated about 90 degrees = {"orientation":"side"}; fully inverted (feet up) = "upside-down"; standing = "upright"; ambiguous lean = "tilted".',
    'body-shape':  'Describe ONLY the body outline. {"shape":"round"|"rectangle"|"oval"|"other"} — round/oval = curved blob, rectangle = blocky with corners. Ignore limbs, parts, colour and face.',
}

PROMPT_C7 = """Image 1 = ONE cartoon monster (a tight crop, the one to judge).
Image 2 = the task picture (shows what the task MEANS — an illustration, not a reference to compare parts with).
TASK: {task}
{how}
Reply ONLY JSON with exactly that one object. {guard}"""

# Second, deliberately-different wording for stripes (variant B). Battery showed
# A and B make DIFFERENT FP sets (A=[0,2,3], B=[0,3,4,6] on tut7) while sharing
# both true cells -> A ∩ B isolates the truth. Gate = intersection exactly-2.
C_HOW_B = {
    'stripes': 'TASK: STRIPES — only the pattern on the body counts.\n'
               'Describe the body pattern of the monster in Image 1 with EXACTLY one value:\n'
               '- "striped": parallel lines, bands or segment divisions running across the body '
               '(faint ones count)\n'
               '- "spots": dots/spots/blotches but no parallel lines\n'
               '- "plain": one flat colour, only edge shading or blush\n'
               '- "other": anything else\n'
               'Reply {"pattern":"striped"|"spots"|"plain"|"other"}.',
}

PROMPT_CB = """Image 1 = one monster (tight crop, body centered). Image 2 = the task picture (striped example).
{how}
Reply ONLY JSON with exactly that one object. {guard}"""


# ---------------------------------------------------------------- signals

PROMPT_V7 = """Image 1 = grid of numbered cells; each cell is a crop of ONE monster (index drawn top-left).
Image 2 = REFERENCE monster cut-out.

TASK: a cell is "same" when the monster has EXACTLY the same top, arms, legs and wings as the REFERENCE monster (same KIND of part — ignore colour, face, size, lean, pose). Otherwise it is "different".

Reply ONLY JSON: {{"cells":{{"1":"same"|"different","2":"same"|"different", ...}}}}
Include EVERY cell index. {guard}"""

PROMPT_S7 = """Image 1 = a SCENE of 8 cartoon monsters. Each monster is marked with a number 1-8 in its top-left corner (1-4 = top row left to right, 5-8 = bottom row left to right).
TASK: SIZE — answer the two questions SEPARATELY:
- "big": the number of the single LARGEST monster
- "small": the number of the single SMALLEST monster
Judge overall body bulk, not headgear or wingspan. Reply ONLY JSON: {{"big":<number>,"small":<number>}}.{guard}"""


_SAME_VOCAB = ('sam', 'yes', 'ide', 'mat', 'twi', 'tru')


def _V(kind, scene, cands, hint, order=None):
    """twins: direct same/different vs reference (different question format
    than B7's 4-cat classification -> independent error modes).
    Images MUST be [grid, hint] to match PROMPT_V7's Image 1/Image 2."""
    prompt = PROMPT_V7.format(guard=_GUARD)
    images = [b64img(build_grid6(scene, cands, order=order)), b64img(hint_img(hint))]
    parsed, raw, ms = _ask(prompt, images, max_tokens=2600,
                           valid=lambda p: isinstance(p.get('cells'), dict))
    cells = parsed.get('cells') or {}
    classif = {}
    for j in range(len(cands)):
        v = cells.get(str(j + 1), cells.get(j + 1))
        classif[j] = bool(v) and str(v).strip().lower().startswith(_SAME_VOCAB)
    return 'V', classif, ms


def _S(scene):
    """size: decomposed biggest/smallest questions (not the joint match list)."""
    prompt = PROMPT_S7.format(guard=_GUARD)
    parsed, raw, ms = _ask(prompt, [b64img(label_scene(scene, None))],
                           max_tokens=150,
                           valid=lambda p: _svals(p) is not None)
    return 'S2', _svals(parsed), ms


def _svals(parsed):
    try:
        a, b = int(parsed.get('big')), int(parsed.get('small'))
    except (TypeError, ValueError):
        return None
    if not (1 <= a <= N_BLOCKS and 1 <= b <= N_BLOCKS) or a == b:
        return None
    return {a - 1, b - 1}


def _G(kind, scene, hint, tag, perm=None):
    pos_note = (' (1-4 = top row left to right, 5-8 = bottom row left to right)'
                if perm is None else ' — the numbers are NOT in reading order, match them exactly as drawn')
    prompt = PROMPT_G7.format(task=HINT_TITLES[kind], pos_note=pos_note, guard=_GUARD)
    parsed, raw, ms = _ask(prompt, [b64img(label_scene(scene, perm)), b64img(hint_img(hint))],
                           max_tokens=200,
                           valid=lambda p: _gvals(p, perm) is not None)
    return tag, _gvals(parsed, perm), ms


def _gvals(parsed, perm=None):
    v = parsed.get('match')
    if isinstance(v, str):
        v = re.findall(r'\d+', v)
    if not isinstance(v, list):
        return None
    labs = []
    for x in v:
        try:
            iv = int(str(x).strip().rstrip('.'))
        except (TypeError, ValueError):
            return None
        if not 1 <= iv <= N_BLOCKS:
            return None
        labs.append(iv - 1)
    labs = list(dict.fromkeys(labs))
    if perm is not None:
        try:
            return {perm.index(l) for l in labs}
        except ValueError:
            return None
    return set(labs)


def _B7(family, kind, scene, cands, hint, order=None):
    with_ref = family == 'ref'
    reply = ('{"ref":{"top":"...","arms":"...","legs":"...","wings":"..."},'
             '"cells":{"1":{"top":"...","arms":"...","legs":"...","wings":"..."},'
             '"2":"incomplete", ...}}' if with_ref else
             '{"cells":{"1":{"top":"...","arms":"...","legs":"...","wings":"..."},'
             '"2":"incomplete", ...}}')
    prompt = PROMPT_B7.format(
        ref_line=('\nImage 2 = REFERENCE monster cut-out (classify it with the same lists).'
                  if with_ref else ''),
        task=HINT_TITLES[kind],
        ref_note=('Classify the REFERENCE monster too and compare each cell against it. '
                  'Output must contain BOTH the "ref" object and the "cells" object.\n'
                  if with_ref else ''),
        reply=reply,
        guard=_GUARD)
    # PROMPT_B7: Image 1 = grid, Image 2 = REFERENCE — send in THAT order
    # (was swapped; coped on tutorial scenes but correlates misreads live).
    images = [b64img(build_grid6(scene, cands, order=order))]
    if with_ref:
        images.append(b64img(hint_img(hint)))
    parsed, raw, ms = _ask(prompt, images, max_tokens=2600,
                           valid=lambda p: isinstance(p.get('cells'), dict)
                           and (not with_ref or norm4(p.get('ref')) is not None))
    cells = parsed.get('cells') or {}
    ref = norm4(parsed.get('ref')) if with_ref and isinstance(parsed.get('ref'), dict) else None
    classif = {}
    for j in range(len(cands)):
        v = cells.get(str(j + 1), cells.get(j + 1))
        if isinstance(v, dict):
            classif[j] = norm4(v)
        else:
            classif[j] = 'incomplete' if v == 'incomplete' else None
    return 'B7', {'ref': ref, 'cells': classif}, ms


NOTHING = {'top': 'nothing on top', 'arms': 'no arms',
           'legs': 'no legs', 'wings': 'no wings'}


def b7_cell_set(kind, b7val, n):
    """Deterministic per-cell rule from one classification (ref + presence)."""
    if not isinstance(b7val, dict):
        return None
    cells = b7val.get('cells') or {}
    ref = b7val.get('ref')
    out = set()
    if kind in ('no-wings', 'arms-legs', 'arms-wings'):
        for j in range(n):
            f = cells.get(j)
            if not isinstance(f, dict):
                continue
            if kind == 'no-wings' and f['wings'] == 'no wings':
                out.add(j)
            elif kind == 'arms-legs' and f['arms'] != 'no arms' and f['legs'] != 'no legs':
                out.add(j)
            elif kind == 'arms-wings' and f['arms'] != 'no arms' and f['wings'] != 'no wings':
                out.add(j)
        return out
    if ref is None:
        return None
    for j in range(n):
        f = cells.get(j)
        if not isinstance(f, dict):
            continue
        if kind == 'twins':
            if f == ref:
                out.add(j)
        elif kind == 'wings':
            if f['wings'] == ref['wings'] and f['wings'] != 'no wings':
                out.add(j)
        elif kind == 'missing':
            diffs = [k for k in SLOT_ORDER if f[k] != ref[k]]
            if len(diffs) == 1 and f[diffs[0]] == NOTHING[diffs[0]] \
                    and ref[diffs[0]] != NOTHING[diffs[0]]:
                out.add(j)
        elif kind == 'extra':
            diffs = [k for k in SLOT_ORDER if f[k] != ref[k]]
            if len(diffs) == 1 and ref[diffs[0]] == NOTHING[diffs[0]] \
                    and f[diffs[0]] != NOTHING[diffs[0]]:
                out.add(j)
    return out


def _body_xy(scene, c):
    """Tap target = body-core centroid of the candidate, not its bbox center.

    Live 2026-10-13 r10 (size): seg merged a tiny 34x28 monster into a 96x40
    bbox -> bbox-center tap landed 19px off the body, registered on-sprite but
    outside the widget's answer circle -> CORRECT blocks failed Verify.  The
    saturation centroid sits on the body heart for every size; falls back to
    bbox center when no saturated core is found (pale/black bodies)."""
    x, y, w, h = c['x'], c['y'], c['w'], c['h']
    roi = scene[y:y + h, x:x + w]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    S, V = hsv[:, :, 1].astype(int), hsv[:, :, 2].astype(int)
    for t in (110, 60):
        m = ((S > t) & (V > 70) & (V < 248)).astype(np.uint8)
        if m.any():
            break
    else:
        return int(c['cx']), int(c['cy'])
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
    if n <= 1:
        return int(c['cx']), int(c['cy'])
    best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    bx = stats[best, cv2.CC_STAT_LEFT] + stats[best, cv2.CC_STAT_WIDTH] // 2
    by = stats[best, cv2.CC_STAT_TOP] + stats[best, cv2.CC_STAT_HEIGHT] // 2
    return int(bx + x), int(by + y)


def champions(cands):
    """{block: cellidx} — largest (monster) cell per grid block."""
    ch = {}
    for j, c in enumerate(cands):
        b = block_of(c['cx'], c['cy'])
        if b not in ch or c['area'] > cands[ch[b]]['area']:
            ch[b] = j
    return ch


def _C(b, j, kind, scene, cands, hint, variant='A'):
    if variant == 'B':
        prompt = PROMPT_CB.format(how=C_HOW_B[kind], guard=_GUARD)
        tag = 'C2'
    else:
        prompt = PROMPT_C7.format(task=HINT_TITLES[kind], how=C_HOW[kind], guard=_GUARD)
        tag = 'C'
    parsed, raw, ms = _ask(prompt, [b64img(cand_crop6(scene, cands[j])), b64img(hint_img(hint))],
                           max_tokens=120,
                           valid=lambda p: isinstance(p, dict) and bool(p))
    return tag, b, parsed, ms


def c_cell_set(kind, cvals, n):
    out = set()
    for j in range(n):
        v = cvals.get(j)
        if not isinstance(v, dict):
            continue
        if kind == 'no-wings':
            if str(v.get('wings', '')).lower().startswith('none'):
                out.add(j)
        elif kind == 'arms-legs':
            if str(v.get('arms', '')).lower().startswith('y') \
                    and str(v.get('legs', '')).lower().startswith('y'):
                out.add(j)
        elif kind == '2-eyes':
            try:
                if int(str(v.get('eyes')).strip().strip('"\'.,')) == 2:
                    out.add(j)
            except (TypeError, ValueError):
                pass
        elif kind == 'stripes':
            if str(v.get('pattern', '')).lower().startswith('strip'):
                out.add(j)
        elif kind == 'upside-down':
            if str(v.get('orientation', '')).lower().startswith('upside'):
                out.add(j)
        elif kind == 'side':
            if str(v.get('orientation', '')).lower().startswith('side'):
                out.add(j)
    return out


def body_cell_set(cvals, n):
    """DIFFERENT BODY: shape per cell -> cells != majority shape."""
    shapes = [str(cvals[j].get('shape', '')).lower() for j in range(n)
              if isinstance(cvals.get(j), dict)]
    shapes = [s for s in shapes if s and s != 'other']
    if not shapes:
        return None
    maj = max(set(shapes), key=shapes.count)
    if shapes.count(maj) < n - 3:
        return None
    return {j for j in range(n)
            if isinstance(cvals.get(j), dict)
            and str(cvals[j].get('shape', '')).lower() not in (maj, 'other')}


# ---------------------------------------------------------------- rules

def _gunion(v, n):
    a, b = v.get('G0'), v.get('G1')
    if a is None or b is None:
        return None
    return a | b


def _ginter(v, n):
    a, b = v.get('G0'), v.get('G1')
    if a is None or b is None:
        return None
    return a & b


def _solo(key):
    return (lambda v, n: _solo_set(v, key), (key,))


def _solo_set(v, key):
    s = v.get(key)
    return None if s is None else set(s)


def _prefer(key, fallback):
    """Trust `key` when it proposes exactly 2; else fall back to another rule."""
    def fn(v, n):
        s = v.get(key)
        if s is not None and len(s) == 2:
            return set(s)
        fb = V7_RULES[fallback]
        return fb[0](v, n)
    return fn, (key, fallback)


def _maj2(keys):
    def fn(v, n):
        return _maj([v.get(k) for k in keys], 2, n)
    return fn, tuple(keys)


def _exact2(s):
    return set(s) if s is not None and len(s) == 2 else None


def _g_b7_equal(v, n):
    """missing/extra fallback: G-inter and B7 must agree on the same pair."""
    gi = _ginter(v, n)
    b = v.get('B7')
    if gi is None or b is None or len(gi) != 2 or set(b) != gi:
        return None
    return gi


def _c_inter_exact2(v, n):
    """stripes: both C wordings must flag a cell; intersection must be exactly 2.

    Wording A and B make disjoint-ish FP sets while sharing the true cells, so
    the intersection strips both wordings' FPs."""
    a, b = v.get('C'), v.get('C2')
    if not a or not b:
        return None
    s = set(a) & set(b)
    return s if len(s) == 2 else None


def _g0_b7_contain(v, n):
    """extra: G0 must be exactly-2 and B7 (independent prompt family) must contain it."""
    g0, b = v.get('G0'), v.get('B7')
    if g0 is None or b is None or len(g0) != 2:
        return None
    s = set(g0)
    return s if s.issubset(set(b)) else None


def _bv_agree(v, n):
    """twins: B7 (4-cat classification) and V (direct same/different) must both
    be exact-2 and identical.  Live 2026-10-13: B7 alone was wrong 2/2."""
    b, vv = v.get('B7'), v.get('V')
    if b is None or vv is None:
        return None
    b, vv = set(b), set(vv)
    return b if len(b) == 2 and b == vv else None


def _bv_subset(v, n):
    """twins: B7 must be exact-2 AND one of B7/V must be a subset of the other.

    Live forensics 2026-10-13: V over-finds on hard scenes (3 cells) and
    under-finds on easy ones (1 cell), but when B7 is WRONG its pick and V's
    set are never nested (r19: B7={1,5} V={3,4,5} -> bail); when B7 is RIGHT
    the sets nest either way (r27: V={1,2,7} superset; tut0: V={7} subset)."""
    b, vv = v.get('B7'), v.get('V')
    if b is None or vv is None:
        return None
    b, vv = set(b), set(vv)
    if len(b) != 2:
        return None
    return b if (vv.issubset(b) or b.issubset(vv)) else None


def _gc_contain(v, n):
    """2-eyes: G-inter exact-2 AND C (per-crop eye count) must contain it.

    Live forensics: r01 claim G={3,5} C={3,5,6} -> propose; r29 wrong
    G={5,7} C={1,2,4,5} (blk8 has 1 eye, not in C) -> bail."""
    gi = _ginter(v, n)
    c = v.get('C')
    if gi is None or c is None or len(gi) != 2:
        return None
    return gi if set(gi).issubset(set(c)) else None


def _g_eq(key):
    """G-inter must be exact-2 AND the second signal must equal it exactly."""
    def fn(v, n):
        gi = _ginter(v, n)
        x = v.get(key)
        if gi is None or x is None or len(gi) != 2 or set(x) != gi:
            return None
        return gi
    return fn, ('G0', 'G1', key)


def _g4(v, n):
    """all four signals (G0, G1, B7, C) must be exact-2 and identical."""
    sets = [v.get(k) for k in ('G0', 'G1', 'B7', 'C')]
    if any(s is None for s in sets):
        return None
    s0 = set(sets[0])
    if len(s0) != 2 or any(set(s) != s0 for s in sets[1:]):
        return None
    return s0


V7_RULES = {
    # exploratory (battery diagnostics / rule search)
    'G0':               _solo('G0'),
    'G1':               _solo('G1'),
    'B7':               _solo('B7'),
    'V':                _solo('V'),
    'S2':               _solo('S2'),
    'C':                _solo('C'),
    'G-inter':          (_ginter, ('G0', 'G1')),
    'G-union':          (_gunion, ('G0', 'G1')),
    'maj2(G0,G1,B7)':   _maj2(('G0', 'G1', 'B7')),
    'maj2(G0,G1,C)':    _maj2(('G0', 'G1', 'C')),
    'C2-else-G':        _prefer('C', 'G-inter'),
    'B72-else-maj2':    _prefer('B7', 'maj2(G0,G1,B7)'),
    # LIVE gates: propose ONLY on exactly-2, never fall back (bail = free retry)
    'B7-exact2':        (lambda v, n: _exact2(v.get('B7')), ('B7',)),
    'V-exact2':         (lambda v, n: _exact2(v.get('V')), ('V',)),
    'G-inter-exact2':   (lambda v, n: _exact2(_ginter(v, n)), ('G0', 'G1')),
    'maj2GB-exact2':    (lambda v, n: _exact2(_maj([v.get('G0'), v.get('G1'),
                                                    v.get('B7')], 2, n)),
                         ('G0', 'G1', 'B7')),
    'C-exact2':         (lambda v, n: _exact2(v.get('C')), ('C',)),
    'C-inter-exact2':    (_c_inter_exact2, ('C', 'C2')),
    'G0B-contain':       (_g0_b7_contain, ('G0', 'B7')),
    'GB-agree':         (_g_b7_equal, ('G0', 'G1', 'B7')),
    'BV-agree':         (_bv_agree, ('B7', 'V')),
    'BV-subset':        (_bv_subset, ('B7', 'V')),
    'GC-contain':       (_gc_contain, ('G0', 'G1', 'C')),
    'GEBeq':            _g_eq('B7'),
    'GEC-equal':        _g_eq('C'),
    'GS-equal':         _g_eq('S2'),
    'G4-equal':         (_g4, ('G0', 'G1', 'B7', 'C')),
    'never':            (lambda v, n: None, ()),
}
DEFAULT_RULE7 = 'G-inter-exact2'

# Per-task primary gate (chosen from battery runs' per-signal reliability):
#   twins        B7 exact-2             (B7 3/3 exact, G systematically wrong on twins)
#   wings/2-eyes/side/size/body  G0==G1 exact-2   (G 3/3; B7/C unreliable there)
#   no-wings/arms  maj2(G0,G1,B7)       (all three strong; maj2 absorbs G1's rare miss)
#   missing      G0==G1 AND ==B7        (signals proven contradictory on tut2 -> mostly bails;
#                                        guards the observed G0==G1 wrong-agreement case)
#   extra        G0 exact-2 AND B7 contains it  (G0 stable-correct on tut3; B7 = independent
#                                        ref-family cross-check that rejects G0 hallucinations)
#   stripes      C_A ∩ C_B exact-2       (two wordings have different FP sets, share truth;
#                                        G always wrong on stripes)
#   upside-down  never                  (G ALWAYS returns the same wrong pair; C is
#                                        nondeterministic and its exact-2 outcomes were
#                                        wrong — no discriminator exists -> always bail)
TASK_RULE = {
    'twins': 'BV-subset',
    'wings': 'G-inter-exact2',
    'missing': 'GB-agree',
    'extra': 'G0B-contain',
    'no-wings': 'G4-equal',
    'arms-legs': 'GEBeq',
    'arms-wings': 'never',
    '2-eyes': 'GC-contain',
    'stripes': 'C-inter-exact2',
    'upside-down': 'never',
    'side': 'G-inter-exact2',
    'biggest-smallest': 'GS-equal',
    'body-shape': 'G-inter-exact2',
}

# Which signals each task computes (G = G0+G1 scene calls, C2 = stripes wording-B)
# Enriched 2026-10-13 after live failures: twins B7 wrong 2/2, size G wrong 2/4,
# 2-eyes G0/G1 disagreement bails — collect an independent second signal each.
TASK_SIGS = {
    'twins': ('B7', 'V'),
    'wings': ('G',),
    'missing': ('G', 'B7'),
    'extra': ('G', 'B7'),
    'no-wings': ('G', 'B7', 'C'),
    'arms-legs': ('G', 'B7', 'C'),
    'arms-wings': (),   # rule='never' -> collect nothing, bail instantly
    '2-eyes': ('G', 'C'),
    'stripes': ('G', 'C', 'C2'),
    'upside-down': (),  # rule='never' -> no calls
    'side': ('G',),
    'biggest-smallest': ('G', 'S2'),
    'body-shape': ('G',),
}


# ---------------------------------------------------------------- solver

def solve(scene, hint, title, sub='', rule=None, workers=6, budget_s=None):
    t0 = time.time()
    kind = parse_task(title, sub)
    family = FAMILY[kind]
    rule = rule or TASK_RULE.get(kind, DEFAULT_RULE7)
    cands, mask, mode = seg6(scene)
    n = len(cands)
    seg_ms = int((time.time() - t0) * 1000)

    t1 = time.time()
    pool = ThreadPoolExecutor(max_workers=workers)
    cellsets, shapes = {}, {}
    need = TASK_SIGS[kind]
    perm_g1 = np.random.default_rng().permutation(N_BLOCKS).tolist()
    rng = np.random.default_rng()
    ch = champions(cands)
    try:
        futs = []
        if 'G' in need:
            futs += [pool.submit(_G, kind, scene, hint, 'G0', None),
                     pool.submit(_G, kind, scene, hint, 'G1', perm_g1)]
        if 'B7' in need:
            futs.append(pool.submit(_B7, family, kind, scene, cands, hint,
                                    rng.permutation(n)))
        if 'V' in need:
            futs.append(pool.submit(_V, kind, scene, cands, hint,
                                    rng.permutation(n)))
        if 'S2' in need:
            futs.append(pool.submit(_S, scene))
        if 'C' in need:
            for b in sorted(ch):
                futs.append(pool.submit(_C, b, ch[b], kind, scene, cands, hint))
        if 'C2' in need:
            for b in sorted(ch):
                futs.append(pool.submit(_C, b, ch[b], kind, scene, cands, hint, 'B'))
        blocks = {'G0': None, 'G1': None, 'B7': None, 'V': None, 'S2': None,
                  'C': None, 'C2': None}
        b7raw, vraw, diag = None, None, {}
        pending = list(futs)

        def _collect(r):
            nonlocal b7raw, vraw
            if r is None:
                return
            tag = r[0]
            if tag in ('G0', 'G1'):
                blocks[tag] = r[1]
            elif tag == 'B7':
                b7raw = r[1]
                diag['B7cells'] = {str(k): v for k, v in (r[1].get('cells') or {}).items()}
                diag['B7ref'] = r[1].get('ref')
            elif tag == 'V':
                vraw = r[1]
            elif tag == 'S2':
                blocks['S2'] = r[1]
            elif tag in ('C', 'C2'):
                _, b, p, _ms = r
                cellsets.setdefault('Craw' if tag == 'C' else 'CrawB', {})[b] = p

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
            print(f'v7solve: vlm budget {budget_s}s hit — '
                  f'{len(pending)} straggler(s) dropped', file=sys.stderr)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

    def _to_blocks(cellset):
        if cellset is None:
            return None
        return {block_of(cands[j]['cx'], cands[j]['cy']) for j in cellset}

    # derive cell sets per needed signal
    if 'B7' in need:
        blocks['B7'] = _to_blocks(b7_cell_set(kind, b7raw, n))
    if 'V' in need and vraw is not None:
        blocks['V'] = _to_blocks({j for j, s in vraw.items() if s})
    if 'C' in need:
        # C runs on block champions -> verdict keys are already blocks
        blocks['C'] = c_cell_set(kind, cellsets.get('Craw', {}), N_BLOCKS)
    if 'C2' in need:
        blocks['C2'] = c_cell_set(kind, cellsets.get('CrawB', {}), N_BLOCKS)

    fn, need = V7_RULES.get(rule, (None, ()))
    matched = None
    if fn is not None:
        try:
            matched = fn(blocks, N_BLOCKS)
        except Exception:
            matched = None
    vms = int((time.time() - t1) * 1000)

    taps = []
    if matched is not None:
        for b in sorted(matched):
            inb = [c for c in cands if block_of(c['cx'], c['cy']) == b]
            if inb:
                best = max(inb, key=lambda c: c['area'])
                taps.append(_body_xy(scene, best))
            else:
                taps.append((int((b % 4) * BW + BW / 2), int((b // 4) * BH + BH / 2)))

    res = {
        'ok': matched is not None,
        'taps': taps,
        'matched': sorted(matched) if matched is not None else [],
        'n_cells': n,
        'task': kind,
        'rule': rule,
        'verdict': {k: (sorted(s) if isinstance(s, set) else s) for k, s in blocks.items()},
        'seg_ms': seg_ms, 'vlm_ms': vms,
        'deadline_hit': deadline_hit,
        'diag': diag,
    }
    if kind == 'body-shape':
        res['shapes'] = {str(j): v.get('shape') for j, v in (shapes or {}).items()
                         if isinstance(v, dict)}
    if family == 'detail':
        res['cell_raw'] = {str(j): v for j, v in cellsets.get('Craw', {}).items()}
        res['cell_rawB'] = {str(j): v for j, v in cellsets.get('CrawB', {}).items()}
    return res


def main():
    if len(sys.argv) >= 5 and sys.argv[1] == '--files':
        scene = cv2.imread(sys.argv[2])
        hint = cv2.imread(sys.argv[3])
        title = sys.argv[4]
        sub = sys.argv[5] if len(sys.argv) > 5 and not sys.argv[5].startswith('maj') else ''
        rule = None
        if len(sys.argv) > 6:
            rule = sys.argv[6]
        elif len(sys.argv) > 5 and sys.argv[5].startswith('maj'):
            rule = sys.argv[5]
        if scene is None or hint is None:
            print(json.dumps({'ok': False, 'reason': 'unreadable-image'}))
            return
        try:
            t0 = time.time()
            res = solve(scene, hint, title, sub, rule=rule, budget_s=34)
            res['wall_ms'] = int((time.time() - t0) * 1000)
        except Exception as e:
            res = {'ok': False, 'reason': f'exception: {e}'}
        print(json.dumps(res), flush=True)
        if res.get('deadline_hit'):
            sys.stdout.flush()
            os._exit(0)
        return
    print('usage: v7solve.py --files scene hint "TASK TITLE" [sub] [rule]')


if __name__ == '__main__':
    main()
