#!/usr/bin/env python3
"""v5solve.py — canonical v5 CAPTCHA solver: segment -> parallel VLM signals
-> majority verdict -> taps.

Signals (all temp=0, ollama.com gemma4:31b, OpenAI-compat chat/completions):
  B  : absolute 5-slot classify of ref + every cell (one grid call)
  E  : ref vs every cell, S/D string per cell (E_SAMPLES=3 grid calls,
       per-cell majority — stabilises run-to-run VLM flips)
  E2 : same as E with shuffled cell order (layout diversity)
  P  : pairwise ref|cand side-by-side, one call per candidate (colour)
  P2 : pairwise with sides swapped (direction diversity)
  S  : pairwise on binary silhouettes (pattern removed; weaker — see analyze7)

RULE selects the combination. If any REQUIRED signal is missing/failed the
rule returns None -> no taps -> the caller must NOT press Verify (bail to
waitManualSolve).

CLI:  v5solve.py <example_idx> [rule]   # tutorial20, prints verdict + timing
"""
import json, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).parent))
import cand_v5
from eval_cv5 import (SHOTS, PROMPT as PROMPT_B, ref_crop, build_grid, b64img,
                      norm_slots, dedupe)
from exp_v5 import ask, PROMPT_E, big_ref
from run_pair import PROMPT_P, pair_image as pair_color
from run_div import PROMPT_P2, build_grid_ord, pair_image2
from run_sil import pair_image as pair_sil


def _solo(v, k, n):
    s = v.get(k)
    return None if s is None else set(s)


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


def _safe_union_cap4(v, n):
    """safe-union, but when it proposes >=4 taps take the intersection of the
    two arms (majcore) instead of the union.

    analyze14 (2026-10-09 battery, 11 labeled live rounds + tutorial20):
      - all observed >=4 safe-union answers were site-REJECTED (0/5) and
        every accepted answer today had <=3 taps -> the cap never changes
        any observed-correct answer (dormant on tutorial20 too, |SU|<4
        there in every cached verdict);
      - cap4->majcore recovered the rejected rounds that were caused by
        extra cells while never producing a cell outside safe-union
        (intersection <= union, so it can only drop, never add);
      - a dropped-set of 0 taps falls through to the caller's existing
        v5-solve-unsafe bail (proven safe path), never a wrong Verify.
    Logs engagement to stderr (visible in bot-loop.log) for forensics.
    """
    su = _safe_union(v, n)
    if su is None or len(su) < 4:
        return su
    a = _maj([v.get('B'), v.get('E'), v.get('P2')], 2, n)
    b = _maj([v.get('B'), v.get('E2'), v.get('P2')], 2, n)
    core = a & b
    print(f'v5solve: cap4-engaged su={sorted(su)} -> core={sorted(core)}',
          file=sys.stderr, flush=True)
    return core


RULES = {
    'B':                (lambda v, n: _solo(v, 'B', n),               ('B',)),
    'E':                (lambda v, n: _solo(v, 'E', n),               ('E',)),
    'P':                (lambda v, n: _solo(v, 'P', n),               ('P',)),
    'maj3(B,E,P)':      (lambda v, n: _maj([v['B'], v['E'], v['P']], 2, n),
                         ('B', 'E', 'P')),
    'maj3(B,E,P2)':     (lambda v, n: _maj([v['B'], v['E'], v['P2']], 2, n),
                         ('B', 'E', 'P2')),
    'safe-union':       (_safe_union, ('B', 'E', 'E2', 'P2')),
    'safe-union-cap4':  (_safe_union_cap4, ('B', 'E', 'E2', 'P2')),
}
# safe-union (analyze11 V2: tutorial20 16/20 strict, 0 traps, 0 fp):
#   accept iff maj2(B, E_maj3, P2) OR maj2(B, E2, P2).
DEFAULT_RULE = 'safe-union'
E_SAMPLES = 3        # identical E grid calls combined by per-cell majority


_pause_until = 0.0        # global cooldown after HTTP 429 (all workers honor it)
_pause_lock = __import__('threading').Lock()


def _ask(prompt, images, max_tokens=2600, tries=4, valid=None):
    """ask() with retries: HTTP errors, bad JSON, or invalid payloads retry.

    ollama.com answers >~6 in-flight requests with HTTP 429 (and drops
    connections mid-upload).  A 429 therefore sets a short GLOBAL pause that
    every worker respects before its next attempt; other errors (bad payload,
    reset, timeout) back off exponentially per signal.  tries=4 keeps the
    worst case (~8s backoff + one real call) inside the solve budget.
    """
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
        print(f'v5solve: _ask try {k + 1}/{tries} failed: '
              f'{type(last).__name__}: {str(last)[:200]}', file=sys.stderr)
        if k + 1 < tries:
            _t.sleep(min(8.0, 1.5 * (2 ** k)))
    raise last


def _valid_B(p):
    from eval_cv5 import norm_slots
    return norm_slots(p.get('ref')) is not None


# ---------------------------------------------------------------- signals

def _sig_B(ref, scene, cands):
    """One grid call: absolute slots for ref + every cell -> matched set."""
    parsed, raw, ms = _ask(PROMPT_B, [b64img(ref_crop(ref)),
                                      b64img(build_grid(scene, cands))],
                           max_tokens=2600, valid=_valid_B)
    rslots = norm_slots(parsed.get('ref'))
    if rslots is None:
        return 'B', None, ms
    cells = parsed.get('cells') or {}
    out = set()
    for j in range(len(cands)):
        f = norm_slots(cells.get(str(j + 1), cells.get(j + 1)))
        if f is not None and f == rslots:
            out.add(j)
    return 'B', out, ms


def _sig_E(ref, scene, cands, tag='E', shuffled_order=None):
    """One grid call: S/D string per cell -> matched (all-S) set."""
    if shuffled_order is None:
        grid = build_grid(scene, cands)
    else:
        grid = build_grid_ord(scene, cands, shuffled_order)
    parsed, raw, ms = _ask(PROMPT_E, [b64img(ref_crop(ref)), b64img(grid)],
                           valid=lambda p: isinstance(p.get('cells'), dict))
    cells = parsed.get('cells') or {}
    out = set()
    for j in range(len(cands)):
        s = cells.get(str(j + 1), cells.get(j + 1))
        if isinstance(s, str):
            s = s.replace(' ', '')
            if len(s) == 5 and set(s) == {'S'}:
                out.add(j)
    return tag, out, ms


def _slots5(parsed):
    s = (parsed or {}).get('slots')
    if isinstance(s, str):
        s = s.replace(' ', '')
        if len(s) == 5 and not set(s) - set('SD'):
            return s
    return None


def _sig_P(j, ref, scene, cands):
    img = pair_color(scene, cands, ref, j)
    parsed, raw, ms = _ask(PROMPT_P, [b64img(img)], max_tokens=60,
                           valid=lambda p: _slots5(p) is not None)
    return 'P', j, _slots5(parsed), ms


def _sig_P2(j, ref, scene, cands):
    img = pair_image2(scene, cands, ref, j)
    parsed, raw, ms = _ask(PROMPT_P2, [b64img(img)], max_tokens=60,
                           valid=lambda p: _slots5(p) is not None)
    return 'P2', j, _slots5(parsed), ms


def _sig_S(j, ref, scene, cands, mode):
    img = pair_sil(scene, mode, cands, ref, j)
    parsed, raw, ms = _ask(PROMPT_P, [b64img(img)], max_tokens=60,
                           valid=lambda p: _slots5(p) is not None)
    return 'S', j, _slots5(parsed), ms


# ---------------------------------------------------------------- solver

def solve(scene, ref, rule=DEFAULT_RULE, workers=6):
    """Returns dict: ok, taps [(x,y)...], verdict {signal: set|None}, ms.

    Signal E is drawn E_SAMPLES times (identical grid image; the endpoint is
    nondeterministic even at temp=0) and combined per-cell by majority — this
    is what makes 'safe-union' (= analyze11 V2) stable.  E2 is one shuffled
    grid call; P2 one pairwise call per candidate; B one grid call.
    """
    t0 = time.time()
    cands, mask, mode = cand_v5.candidates(scene)
    n = len(cands)
    seg_ms = int((time.time() - t0) * 1000)
    fn, need = RULES[rule]
    verdict = {k: None for k in need}
    slots = {k: {} for k in need if k in ('P', 'P2', 'S')}
    rng_order = None
    if 'E2' in need:
        import numpy as np
        rng_order = np.random.default_rng().permutation(n).tolist()

    t1 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = []
        if 'B' in need:
            futs.append(pool.submit(_sig_B, ref, scene, cands))
        if 'E' in need:
            for k in range(E_SAMPLES):
                futs.append(pool.submit(_sig_E, ref, scene, cands, f'e{k}', None))
        if 'E2' in need:
            futs.append(pool.submit(_sig_E, ref, scene, cands, 'E2', rng_order))
        for j in range(n):
            if 'P' in need:
                futs.append(pool.submit(_sig_P, j, ref, scene, cands))
            if 'P2' in need:
                futs.append(pool.submit(_sig_P2, j, ref, scene, cands))
            if 'S' in need:
                futs.append(pool.submit(_sig_S, j, ref, scene, cands, mode))
        grid = {}
        for fu in as_completed(futs):
            try:
                r = fu.result()
            except Exception:
                r = None
            if r is None:                          # hard failure: unknown signal
                continue                           # (blocks set below via coverage)
            if len(r) == 3:                        # (tag, set|None, ms)
                tag, s, _ms = r
                grid[tag] = s
            else:                                  # ('P'|'P2'|'S', j, slots5|None, ms)
                tag, j, s, _ms = r
                slots[tag][j] = s
    if 'B' in need:
        verdict['B'] = grid.get('B')
    if 'E2' in need:
        verdict['E2'] = grid.get('E2')
    if 'E' in need:
        # Samples are tagged 'e0'..'e2' (lowercase) so they can never collide
        # with the E2 signal tag.  Partial API failures degrade the majority
        # over the usable samples instead of rejecting the whole signal: with
        # 3 usable -> 2/3, with 2 -> unanimous, with 1 -> single-sample (the
        # pre-V2 baseline signal).  Only a total failure blocks the rule.
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
            verdict[tag] = None                    # signal never completed
        else:
            # a cell whose call failed after retries is simply not accepted
            # (precision-safe: absent = reject vote)
            failed_cells += n - len(vals)
            verdict[tag] = {j for j, v in vals.items() if v == 'SSSSS'}
    vms = int((time.time() - t1) * 1000)

    matched = fn(verdict, n)
    if matched is None:
        missing = [k for k in need if verdict.get(k) is None]
        return {'ok': False, 'reason': f'signal-missing({",".join(missing)})',
                'verdict': verdict,
                'n': n, 'seg_ms': seg_ms, 'vlm_ms': vms}
    kept = dedupe(matched, cands)
    taps = [(int(c['cx']), int(c['cy'])) for c in kept]
    return {'ok': True, 'taps': taps, 'n': n, 'matched': sorted(matched),
            'verdict': verdict, 'seg_ms': seg_ms, 'vlm_ms': vms,
            'failed_cells': failed_cells}


def main():
    if len(sys.argv) >= 4 and sys.argv[1] == '--files':
        # bot integration: v5solve.py --files scene.png ref.png [rule]
        scene = cv2.imread(sys.argv[2])
        ref = cv2.imread(sys.argv[3])
        if scene is None or ref is None:
            print(json.dumps({'ok': False, 'reason': 'unreadable-image'}))
            return
        rule = sys.argv[4] if len(sys.argv) > 4 else DEFAULT_RULE
        try:
            t0 = time.time()
            res = solve(scene, ref, rule=rule)
            res['wall_ms'] = int((time.time() - t0) * 1000)
        except Exception as e:
            res = {'ok': False, 'reason': f'exception: {e}'}
        res['verdict'] = {k: (sorted(s) if isinstance(s, set) else s)
                          for k, s in (res.get('verdict') or {}).items()}
        print(json.dumps(res))
        return
    i = int(sys.argv[1])
    rule = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_RULE
    scene = cv2.imread(str(SHOTS / f'tut{i:02d}-scene.png'))
    ref = cv2.imread(str(SHOTS / f'tut{i:02d}-ref.png'))
    t0 = time.time()
    res = solve(scene, ref, rule=rule)
    res['wall_ms'] = int((time.time() - t0) * 1000)
    v = res.get('verdict') or {}
    res['verdict'] = {k: (sorted(s) if isinstance(s, set) else s)
                      for k, s in v.items()}
    print(json.dumps(res, indent=1))


if __name__ == '__main__':
    main()
