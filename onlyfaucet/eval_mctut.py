#!/usr/bin/env python3
"""eval_mctut.py — official-onlyfaucet tutorial battery (mcaptchav5.html).

20 official examples (site's own "How to solve" page) with ground-truth
zones+radii, trap decoys (`near` = decoy center/radius, `trap` = which slots
differ), and the ref's true slot `hint`.  Static page -> zero account impact;
VLM = ollama.com only.

  python3 eval_mctut.py run [runs]   # replay solve() -> battery15-mctut.json
  python3 eval_mctut.py score        # all analyze14 rules vs official zones
  python3 eval_mctut.py traps        # failed scenes vs official trap notes
"""
import json, math, sys, time
from pathlib import Path

import cv2

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from v5solve import solve               # noqa: E402
from analyze14 import RULE_FUNCS        # noqa: E402
import cand_v5                          # noqa: E402

MC = HERE / 'v5' / 'mctut20'
OUT = HERE / 'battery15-mctut.json'
R = json.load(open(MC / 'mctut20.json'))


def load(i):
    scene = cv2.imread(str(MC / f'mc{i:02d}-scene.png'))
    ref = cv2.imread(str(MC / f'mc{i:02d}-ref.png'))
    cands, _, _ = cand_v5.candidates(scene)
    return scene, ref, cands


def dedupe(idxs, cands, r=20):
    keep = []
    for j in sorted(idxs, key=lambda j: -cands[j]['area']):
        if all((cands[j]['cx'] - cands[k]['cx']) ** 2 + (cands[j]['cy'] - cands[k]['cy']) ** 2
               > r * r for k in keep):
            keep.append(j)
    return keep


def strict_mc(idxs, ex, cands):
    """exact-set vs official zones: every zone covered by a tap within its
    radius; any tap outside all zone-radii = fp (traps are outside)."""
    hits = 0
    for z in ex['zones']:
        if any(math.hypot(cands[j]['cx'] - z[0], cands[j]['cy'] - z[1]) <= z[2]
               for j in idxs):
            hits += 1
    fp = any(not any(math.hypot(cands[j]['cx'] - z[0], cands[j]['cy'] - z[1]) <= z[2]
                     for z in ex['zones']) for j in idxs)
    return hits == len(ex['zones']) and not fp, hits, fp


def cell_of(tap, cands, tol=6):
    for j, c in enumerate(cands):
        if abs(c['cx'] - tap[0]) <= tol and abs(c['cy'] - tap[1]) <= tol:
            return j
    return None


def cmd_run(runs=2):
    out = json.load(open(OUT)) if OUT.exists() else {}
    for i in range(len(R)):
        key = str(i)
        if key in out and len(out[key].get('runs', [])) >= runs:
            print(i, 'cached', flush=True)
            continue
        scene, ref, cands = load(i)
        runs_out = []
        for k in range(runs):
            t0 = time.time()
            res = solve(scene, ref)      # default safe-union (need B,E,E2,P2)
            res['verdict'] = {kk: (sorted(vv) if isinstance(vv, set) else vv)
                              for kk, vv in (res.get('verdict') or {}).items()}
            res['wall'] = round(time.time() - t0, 1)
            runs_out.append(res)
            print(i, f'run{k+1}', 'ok=' + str(res['ok']), 'taps=', res.get('taps'),
                  res['wall'], 's', flush=True)
        out[key] = {'n': len(cands),
                    'cells': [[int(c['cx']), int(c['cy'])] for c in cands],
                    'runs': runs_out}
        json.dump(out, open(OUT, 'w'), indent=1)
    print('run done ->', OUT)


def _tapidx(res, cands):
    return [cell_of(tuple(t), cands) for t in (res.get('taps') or [])]


def cmd_score():
    data = json.load(open(OUT))
    print(f"{'rule':20s} strict  hits/44  fp  fails(run1)")
    total_zones = sum(len(ex['zones']) for ex in R)
    for name, fn in RULE_FUNCS.items():
        npass = nhit = nfp = 0
        fails = []
        for i in range(len(R)):
            ex = R[i]
            e = data.get(str(i))
            if not e:
                continue
            scene, ref, cands = load(i)
            r = e['runs'][0]
            v = {k: (set(s) if isinstance(s, list) else s)
                 for k, s in (r.get('verdict') or {}).items()}
            m = fn(v, e['n'])
            if m is None:
                fails.append(f'{i}:nodata')
                continue
            kept = dedupe(m, cands)
            ok, hits, fp = strict_mc(kept, ex, cands)
            npass += ok
            nhit += hits
            nfp += fp
            if not ok:
                fails.append(f'{i}:{hits}/{len(ex["zones"])}{"F" if fp else ""}')
        print(f'{name:20s} {npass:2d}/20  {nhit:2d}/{total_zones}  {nfp:2d}   '
              + ' '.join(fails))
    # baseline across both runs for variance
    print('\nsafe-union per-run strict:')
    for i in range(len(R)):
        e = data.get(str(i))
        if not e:
            continue
        scene, ref, cands = load(i)
        oks = []
        for r in e['runs']:
            m = RULE_FUNCS['safe-union'](
                {k: (set(s) if isinstance(s, list) else s)
                 for k, s in (r.get('verdict') or {}).items()}, e['n'])
            kept = dedupe(m, cands) if m is not None else []
            oks.append(strict_mc(kept, R[i], cands)[0])
        print(f'  {i:2d}: {oks}')


def cmd_traps():
    """For every failed scene: picked-but-wrong cells and missed zones, with
    the official trap annotations (which slots the decoy differs on)."""
    data = json.load(open(OUT))
    for i in range(len(R)):
        ex = R[i]
        e = data.get(str(i))
        if not e:
            continue
        scene, ref, cands = load(i)
        r = e['runs'][0]
        m = RULE_FUNCS['safe-union'](
            {k: (set(s) if isinstance(s, list) else s)
             for k, s in (r.get('verdict') or {}).items()}, e['n'])
        kept = dedupe(m or [], cands)
        ok, hits, fp = strict_mc(kept, ex, cands)
        if ok:
            continue
        extras = [j for j in kept
                  if not any(math.hypot(cands[j]['cx'] - z[0], cands[j]['cy'] - z[1]) <= z[2]
                             for z in ex['zones'])]
        missed = [z for z in ex['zones']
                  if not any(math.hypot(cands[j]['cx'] - z[0], cands[j]['cy'] - z[1]) <= z[2]
                             for j in kept)]
        near_hit = [j for j in extras
                    if ex.get('near') and any(
                        math.hypot(cands[j]['cx'] - z[0], cands[j]['cy'] - z[1]) <= z[2]
                        for z in ex['near'])]
        print(f"{i:2d} hint={ex['hint']}")
        print(f"     kept={kept} extras={extras} onOfficialTrap={near_hit} "
              f"missedZones={[[round(v,1) for v in z] for z in missed]}")
        if ex.get('trap'):
            print(f"     officialTrap: {'; '.join(ex['trap'])}")


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'run'
    if cmd == 'run':
        cmd_run(int(sys.argv[2]) if len(sys.argv) > 2 else 2)
    elif cmd == 'score':
        cmd_score()
    elif cmd == 'traps':
        cmd_traps()
    else:
        print(__doc__)
