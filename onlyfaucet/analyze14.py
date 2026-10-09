#!/usr/bin/env python3
"""analyze14.py — offline battery: today's live rounds (2026-10-09) + tutorial20.

Question (user-approved): every site-accepted live answer today had <=3 taps,
every >=4-tap submission was rejected (0/4).  Would a precision rule (tap-count
prior / unanimous core) have flipped today's misses without breaking valid
multi-target scenes?  Zero live events — ollama.com VLM only.

Data: 11 labeled rounds from bot-loop.log — 6 site-ACCEPTED (truth = submitted
registered taps) and 5 site-REJECTED (truth = visual labeling of scene+ref,
entered in TRUTH below).  tutorial20 provides exact-zone labels for <=3-target
scenes; cached verdicts in v5/ make that part free.

Phases:
  python3 analyze14.py annot            # annotated composites for labeling
  python3 analyze14.py replay [runs]    # fresh signal replay -> battery14-replay.json
  python3 analyze14.py tut              # candidate rules on tutorial20 (cached)
  python3 analyze14.py score            # candidate rules on replay vs labels
"""
import json, sys, time
from pathlib import Path

import cv2

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

# Patch BEFORE analyze* imports — they snapshot SHOTS at import time.  The
# tutorial set lives in the repo (v5/), not /tmp (wiped by the Oct 8 reboot).
import eval_cv5
eval_cv5.SHOTS = HERE / 'v5'

from v5solve import solve, RULES          # noqa: E402
import cand_v5                            # noqa: E402
from analyze import cell_sets, dedupe_taps, strict  # noqa: E402

SHOTS = Path('/tmp/onlyfaucet-shots')
REPLAY = HERE / 'battery14-replay.json'

# id, label, scene-ts, submitted (registered ca_ taps, live log)
ROUNDS = [
    ('A1', 'acc', 1791533796749, [[135, 79], [323, 232]]),
    ('A2', 'acc', 1791534436691, [[123, 79], [383, 166], [290, 209]]),
    ('A3', 'acc', 1791535057182, [[136, 78], [151, 210]]),
    ('A4', 'acc', 1791536396705, [[145, 200], [136, 44]]),
    ('A5', 'acc', 1791537238064, [[285, 67], [106, 98]]),
    ('A6', 'acc', 1791539615061, [[251, 197], [73, 173]]),
    ('R1', 'rej', 1791535727909, [[260, 59], [135, 138], [176, 75], [227, 181]]),
    ('R2', 'rej', 1791537279757, [[340, 68], [43, 133], [113, 212], [297, 230], [241, 138]]),
    ('R3', 'rej', 1791538134062, [[87, 209], [73, 120], [325, 58]]),
    ('R4', 'rej', 1791539652917, [[122, 67], [58, 224], [312, 89], [217, 53]]),
    ('R5', 'rej', 1791540078616, [[56, 208], [292, 232], [206, 171], [277, 64], [115, 49]]),
]

# Visual ground truth for REJECTED rounds: cell-center indices (per cells[]
# printed by `annot`) that genuinely match the ref creature.  Established by
# zoomed ref-vs-cell inspection + witness elimination (see battery14-*-zoom*.png).
# Accepted rounds inherit their submitted taps.
TRUTH_CELLS = {
    # R1: cell1's top bump is a ROUND dome vs the ref's pointed cone -> extra;
    #     all other candidates lack legs/tail (g3/g8/g9).  Medium confidence
    #     (elimination); alternative reading = a zero-vitness blind-spot miss,
    #     under which NO tested rule improves either.  [3,5,6] or [1,3,5,6]+miss
    'R1': [3, 5, 6],
    # R2: cell5 = round-headed rectangular creature vs ref eyes-on-body oval
    #     (zoom-confirmed extra); zero votes outside submitted set.  High.
    'R2': [1, 4, 8, 9],
    # R3: cell7 has eyes on a distinct head lobe vs ref eyes-on-body (extra);
    #     cell4 zoom shows legs+tail present (B was wrong); cell3 has no legs.
    #     By elimination.  Medium-high.
    'R3': [1, 4],
    # R4: cell6 = pink fish zoom-confirmed IDENTICAL construction (missed match,
    #     B+Bdump wanted it, E/E2/P2 vetoed); cell7 no wing (excluded); rest of
    #     submitted set confirmed.  High.  => 5 true targets.
    'R4': [0, 1, 3, 6, 8],
    # R5: cell9 = spiky/star body vs ref clean hexagon (zoom-confirmed extra);
    #     cell7 hexagon+dome wing+zigzag tail confirmed; cell5/6 no legs.
    #     High.
    'R5': [1, 2, 7, 8],
}


# ------------------------------------------------------------------ rules

def _maj(vs, need, n):
    if any(s is None for s in vs):
        return None
    return {j for j in range(n) if sum(j in s for s in vs) >= need}


def r_safe(v, n):
    return RULES['safe-union'][0](v, n)


def r_core(v, n):
    """Unanimous core: B AND E AND E2 AND P2 (max precision)."""
    ss = [v.get(k) for k in ('B', 'E', 'E2', 'P2')]
    if any(s is None for s in ss):
        return None
    return set.intersection(*ss)


def r_majcore(v, n):
    """Intersection of the two safe-union arms (precision version of safe-union)."""
    a = _maj([v.get('B'), v.get('E'), v.get('P2')], 2, n)
    b = _maj([v.get('B'), v.get('E2'), v.get('P2')], 2, n)
    if a is None or b is None:
        return None
    return a & b


def _cap(fn4, cap):
    def f(v, n):
        su = r_safe(v, n)
        if su is None:
            return None
        return fn4(v, n) if len(su) >= cap else su
    return f


RULE_FUNCS = {
    'safe-union': r_safe,
    'core4(B^E^E2^P2)': r_core,
    'majcore(su arms ^)': r_majcore,
    'cap4->majcore': _cap(r_majcore, 4),
    'cap4->core4': _cap(r_core, 4),
    'cap5->majcore': _cap(r_majcore, 5),
}


# ------------------------------------------------------------------ annot

def cmd_annot():
    """Composite: ref (x2) on top, scene (x2) below with numbered candidate
    boxes and the submitted taps circled — for visual ground-truth labeling."""
    from PIL import Image, ImageDraw
    for rid, lab, ts, taps in ROUNDS:
        scene = cv2.imread(str(SHOTS / f'v5-scene-{ts}.png'))
        ref = cv2.imread(str(SHOTS / f'v5-ref-{ts}.png'))
        cands, _, _ = cand_v5.candidates(scene)
        sim = Image.fromarray(cv2.cvtColor(scene, cv2.COLOR_BGR2RGB)).resize((900, 560), Image.NEAREST)
        rim = Image.fromarray(cv2.cvtColor(ref, cv2.COLOR_BGR2RGB)).resize((300, 220), Image.NEAREST)
        d = ImageDraw.Draw(sim)
        for j, c in enumerate(cands):
            x, y = c['cx'] * 2, c['cy'] * 2
            d.ellipse([x - 34, y - 34, x + 34, y + 34], outline=(0, 255, 0), width=3)
            d.text((x - 8, y - 46), str(j), fill=(0, 255, 0))
        for k, (tx, ty) in enumerate(taps):
            x, y = tx * 2, ty * 2
            d.ellipse([x - 26, y - 26, x + 26, y + 26], outline=(255, 0, 0), width=4)
            d.text((x + 28, y - 8), f'T{k}', fill=(255, 0, 0))
        out = Image.new('RGB', (900, 560 + 230), (20, 20, 20))
        out.paste(rim, (300, 5))
        out.paste(sim, (0, 230))
        p = SHOTS / f'battery14-{rid}-annot.png'
        out.save(p)
        print(rid, lab, 'cells=', len(cands), '->', p)
        print('   submitted T:', list(enumerate(taps)))
        print('   cells:', [[int(c['cx']), int(c['cy'])] for c in cands])


# ------------------------------------------------------------------ replay

def cmd_replay(runs=2):
    out = json.load(open(REPLAY)) if REPLAY.exists() else {}
    for rid, lab, ts, taps in ROUNDS:
        if rid in out and len(out[rid].get('runs', [])) >= runs:
            print(rid, 'cached', flush=True)
            continue
        scene = cv2.imread(str(SHOTS / f'v5-scene-{ts}.png'))
        ref = cv2.imread(str(SHOTS / f'v5-ref-{ts}.png'))
        cands, _, _ = cand_v5.candidates(scene)
        runs_out = []
        for k in range(runs):
            t0 = time.time()
            res = solve(scene, ref)     # default safe-union (need: B,E,E2,P2)
            res['verdict'] = {kk: (sorted(vv) if isinstance(vv, set) else vv)
                              for kk, vv in (res.get('verdict') or {}).items()}
            res['wall'] = round(time.time() - t0, 1)
            runs_out.append(res)
            print(rid, f'run{k + 1}', 'ok=' + str(res['ok']), 'taps=',
                  res.get('taps'), res.get('reason'), res['wall'], 's', flush=True)
        out[rid] = {
            'label': lab, 'ts': ts, 'submitted': taps, 'n': len(cands),
            'cells': [[int(c['cx']), int(c['cy'])] for c in cands],
            'runs': runs_out,
        }
        json.dump(out, open(REPLAY, 'w'), indent=1)
    print('replay done ->', REPLAY)


# ------------------------------------------------------------------ truth

def truth_zones(rid, entry):
    """zones for strict(): accepted -> submitted taps; rejected -> TRUTH_CELLS."""
    if entry['label'] == 'acc':
        return entry['submitted']
    cells = TRUTH_CELLS.get(rid)
    if cells is None:
        return None
    return [entry['cells'][j] for j in cells]


def score_entry(rid, entry, rule_fn):
    """(per_run ok list, detail str). None zones -> ('nolabel', ...)."""
    zones = truth_zones(rid, entry)
    if zones is None:
        return None, 'nolabel'
    ex = {'zones': zones, 'near': []}
    scene = cv2.imread(str(SHOTS / f"v5-scene-{entry['ts']}.png"))
    cands, _, _ = cand_v5.candidates(scene)
    oks = []
    for r in entry['runs']:
        v = {k: (set(s) if isinstance(s, list) else s)
             for k, s in (r.get('verdict') or {}).items()}
        m = rule_fn(v, entry['n'])
        if m is None:
            oks.append(False)
            continue
        kept = dedupe_taps(m, cands)
        ok, hits, trap, fp = strict(kept, ex)
        oks.append(ok)
    return oks, f"zones={len(zones)}"


def cmd_score():
    data = json.load(open(REPLAY))
    ids = [r[0] for r in ROUNDS]
    print(f"{'rule':20s} " + ' '.join(f'{i:>6s}' for i in ids) + '   totals')
    for name, fn in RULE_FUNCS.items():
        row, acc_ok, rej_ok, unl = [], 0, 0, 0
        for rid in ids:
            e = data[rid]
            oks, _ = score_entry(rid, e, fn)
            if oks is None:
                row.append('  nolb')
                unl += 1
                continue
            good = all(oks)
            row.append('  PASS' if good else '  fail')
            if e['label'] == 'acc':
                acc_ok += good
            else:
                rej_ok += good
        print(f'{name:20s} ' + ' '.join(row)
              + f'   acc {acc_ok}/6 rej {rej_ok}/{5 - unl}' + (f' unl {unl}' if unl else ''))
    print('\nper-run detail (rule=safe-union vs cap4->majcore):')
    for rid in ids:
        e = data[rid]
        det = []
        for name in ('safe-union', 'cap4->majcore', 'core4(B^E^E2^P2)'):
            oks, note = score_entry(rid, e, RULE_FUNCS[name])
            det.append(f'{name}={oks}')
        print(f"  {rid} {e['label']} n={e['n']} " + '  '.join(det))


def cmd_tut():
    """Candidate rules on tutorial20 using the CACHED verdicts (no VLM)."""
    from analyze import R as TUT
    from analyze5 import vB, vP
    from analyze8 import vE2, vP2, RA, PR
    from analyze10 import REP, _to0

    def verdict(i, n):
        res = RA.get(str(i), {})
        e_s = [s for s in (_to0((res.get('E') or {}).get('cells')),
                           REP[str(i)].get('E_b'),
                           REP[str(i)].get('E_c')) if s is not None]
        E = None
        if e_s:
            thr = len(e_s) // 2 + 1     # runtime semantics: pooled majority
            E = {j for j in range(n) if sum(_cell_e(s, j) for s in e_s) >= thr}
        return {'B': vB(res.get('B'), n), 'E': E,
                'E2': vE2(i, n), 'P2': vP2(i, n), 'P': vP(PR.get(str(i), {}), n)}

    cell_list = [cell_sets(i) for i in range(len(TUT))]
    print(f"{'rule':20s} strict  recall traps fp  fails")
    for name, fn in RULE_FUNCS.items():
        npass = ntrap = nfp = zhit = ztot = 0
        fails = []
        for i in range(len(TUT)):
            cands, zc, tc, ex = cell_list[i]
            m = fn(verdict(i, len(cands)), len(cands))
            if m is None:
                fails.append(f'{i}:nodata')
                continue
            kept = dedupe_taps(m, cands)
            ok, hits, trap, fp = strict(kept, ex)
            npass += ok
            zhit += hits
            ztot += len(ex['zones'])
            ntrap += trap
            nfp += fp
            if not ok:
                fails.append(f'{i}:{hits}/{len(ex["zones"])}'
                             f'{"T" if trap else ""}{"F" if fp else ""}')
        print(f'{name:20s} {npass:2d}/20  {zhit:2d}/{ztot}  {ntrap:2d}   {nfp:2d}  {" ".join(fails)}')


def _cell_e(cells, j):
    s = cells.get(str(j), cells.get(j))
    if not isinstance(s, str):
        return False
    s = s.replace(' ', '')
    return len(s) == 5 and set(s) == {'S'}


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'annot'
    if cmd == 'annot':
        cmd_annot()
    elif cmd == 'replay':
        cmd_replay(int(sys.argv[2]) if len(sys.argv) > 2 else 2)
    elif cmd == 'tut':
        cmd_tut()
    elif cmd == 'score':
        cmd_score()
    else:
        print(__doc__)
