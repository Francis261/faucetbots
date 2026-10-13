#!/usr/bin/env python3
"""eval_v7.py — battery harness for v7solve over v7/mctut12 (12 official tasks).

  python3 eval_v7.py run [K]     # K solves per scene (default 1), caches JSON
  python3 eval_v7.py score       # per-rule strict score over cached verdicts
  python3 eval_v7.py search      # exhaustive 65,536 boolean-rule search
"""
import json, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from v7solve import solve, V7_RULES, N_BLOCKS, block_of            # noqa: E402

HERE = Path(__file__).parent
LABELS = json.load(open(HERE / 'v7' / 'mctut12' / 'mctut12.json'))
OUT = HERE / 'battery-v7-mctut12.json'

TRUTH = [sorted({block_of(x, y) for x, y in L['answers']}) for L in LABELS]


def load():
    if OUT.exists():
        return json.load(open(OUT))
    return {}


def cmd_run(k=1):
    data = load()
    import cv2
    for L in LABELS:
        i = L['i']
        key = str(i)
        data.setdefault(key, {'runs': []})
        while len(data[key]['runs']) < k:
            ri = len(data[key]['runs'])
            scene = cv2.imread(str(HERE / 'v7' / 'mctut12' / f'v7{i:02d}-scene.webp'))
            hint = cv2.imread(str(HERE / 'v7' / 'mctut12' / f'v7{i:02d}-hint.webp'))
            t0 = time.time()
            try:
                res = solve(scene, hint, L['title'], L['sub'])
            except Exception as e:
                res = {'ok': False, 'reason': f'exception: {e}'}
            run = {'ok': res.get('ok'), 'matched': res.get('matched'),
                   'verdict': res.get('verdict'), 'task': res.get('task'),
                   'rule': res.get('rule'), 'n_cells': res.get('n_cells'),
                   'seg_ms': res.get('seg_ms'), 'vlm_ms': res.get('vlm_ms'),
                   'wall_s': round(time.time() - t0, 1),
                   'shapes': res.get('shapes'), 'cell_raw': res.get('cell_raw')}
            data[key]['runs'].append(run)
            print(f"{L['title'][:38]:40s} run{ri + 1} ok={run['ok']} "
                  f"matched={run['matched']} truth={TRUTH[i]} {run['wall_s']}s",
                  flush=True)
            json.dump(data, open(OUT, 'w'), indent=1)
    print(f"run done -> {OUT}")


def _v(run, k):
    v = run.get('verdict') or {}
    s = v.get(k)
    return None if s is None else set(s)


def strict_sets(matched, i):
    if matched is None:
        return False, 0, 0
    m, t = set(matched), set(TRUTH[i])
    ok = (m == t and len(m) == 2)
    return ok, len(m & t), len(m - t)


def cmd_score():
    data = load()
    print(f"{'rule':22s} {'strict':>7s} {'hits':>7s} {'fp':>4s}  fails(run1)")
    for name, (fn, _need) in V7_RULES.items():
        st = hits = fp = 0
        fails = []
        total = 0
        for i in range(len(LABELS)):
            e = data.get(str(i))
            if not e or not e['runs']:
                continue
            run = e['runs'][0]
            v = {k: _v(run, k) for k in ('G0', 'G1', 'B7', 'C', 'C2')}
            try:
                m = fn(v, N_BLOCKS)
            except Exception:
                m = None
            ok, h, f = strict_sets(m, i)
            st += ok
            hits += h
            fp += f
            total += 2
            if not ok:
                fails.append(f"{i}:{len(m) if m is not None else 'X'}/2")
        print(f"{name:22s} {st:3d}/12 {hits:4d}/{total if total else 0} {fp:4d}  {' '.join(fails)}")


def cmd_search():
    """Exhaustive boolean rules over 4 signals (G0,G1,B7,C) per cell-block."""
    data = load()
    rows = []
    sigkeys = ('G0', 'G1', 'B7', 'C')
    for i in range(len(LABELS)):
        e = data.get(str(i))
        if not e or not e['runs']:
            continue
        for ri, run in enumerate(e['runs']):
            v = run.get('verdict') or {}
            bits = [sum((1 << s) for s, k in enumerate(sigkeys)
                        if v.get(k) is not None and b in set(v.get(k) or []))
                    for b in range(N_BLOCKS)]
            rows.append((i, ri, bits))
    total_runs = len(rows)
    best = []
    for f in range(1 << 16):
        st = hits = fp = 0
        for i, ri, bits in rows:
            m = {b for b in range(N_BLOCKS) if (f >> bits[b]) & 1}
            ok, h, x = strict_sets(m, i)
            st += ok
            hits += h
            fp += x
        best.append((st, hits, -fp, f))
    best.sort(reverse=True)
    print(f"{total_runs} runs ({len(set(r[0] for r in rows))} scenes)")
    print(f"{'f':>7s} {'strict':>7s} {'hits':>7s} {'fp':>4s}")
    for st, hits, negfp, f in best[:15]:
        print(f"0x{f:04x}   {st:3d}/{total_runs} {hits:4d}/{2 * total_runs} {-negfp:4d}")
    # named rules for reference
    print("\nnamed rules:")
    for name, (fn, _n) in V7_RULES.items():
        st = hits = fp = 0
        for i in range(len(LABELS)):
            e = data.get(str(i))
            if not e or not e['runs']:
                continue
            run = e['runs'][0]
            v = {k: _v(run, k) for k in ('G0', 'G1', 'B7', 'C', 'C2')}
            try:
                m = fn(v, N_BLOCKS)
            except Exception:
                m = None
            ok, h, x = strict_sets(m, i)
            st += ok
            hits += h
            fp += x
        print(f"{name:22s} {st:3d}/12 {hits:4d}/24 {fp:4d}")


# Candidate gates per scene index (12 tutorial tasks, i=0 twins .. i=11 body).
# Evaluated over EVERY cached run (not just run1) — endpoint varies between
# battery invocations, so precision must hold across all runs.
CANDS7 = {
    0:  ['B7-exact2', 'V-exact2', 'BV-agree', 'BV-subset'],               # twins
    1:  ['G-inter-exact2'],                                             # wings
    2:  ['GB-agree', 'G-inter-exact2', 'GEBeq', 'maj2GB-exact2'],       # missing
    3:  ['G0B-contain', 'G-inter-exact2', 'GEBeq'],                     # extra
    4:  ['maj2GB-exact2', 'G-inter-exact2', 'GEBeq', 'GEC-equal',
         'GB-agree', 'G4-equal'],                                       # no-wings
    5:  ['maj2GB-exact2', 'G-inter-exact2', 'GEBeq', 'G4-equal'],       # arms-legs
    6:  ['G-inter-exact2', 'GEC-equal', 'C-exact2', 'GC-contain'],      # 2-eyes
    7:  ['C-inter-exact2'],                                             # stripes
    8:  ['never'],                                                      # upside-down
    9:  ['G-inter-exact2'],                                             # side
    10: ['G-inter-exact2', 'GS-equal', 'S2'],                           # size
    11: ['G-inter-exact2'],                                             # body
}


def cmd_scoreall():
    """Per task × candidate gate over ALL cached runs: precision + coverage."""
    data = load()
    print(f"{'task':16s} {'rule':16s} {'runs':>4s} {'prop':>4s} {'ok':>3s} "
          f"{'WRONG':>5s} {'cov%':>5s}   fails")
    summary = []
    for i in range(len(LABELS)):
        e = data.get(str(i))
        if not e or not e['runs']:
            continue
        t = set(TRUTH[i])
        for rule in CANDS7.get(i, []):
            fn, _n = V7_RULES[rule]
            runs = prop = ok = wrong = 0
            fails = []
            for ri, run in enumerate(e['runs']):
                runs += 1
                v = {k: _v(run, k) for k in ('G0', 'G1', 'B7', 'V', 'S2', 'C', 'C2')}
                try:
                    m = fn(v, N_BLOCKS)
                except Exception:
                    m = None
                if m is None:
                    continue
                prop += 1
                if set(m) == t and len(m) == 2:
                    ok += 1
                else:
                    wrong += 1
                    fails.append(f"r{ri + 1}:{sorted(m)}")
            cov = round(100 * prop / runs) if runs else 0
            name = KIND_NAME[i]
            print(f"{name:16s} {rule:16s} {runs:4d} {prop:4d} {ok:3d} "
                  f"{wrong:5d} {cov:4d}%   {' '.join(fails)}")
            summary.append((name, rule, wrong, cov))
    bad = [s for s in summary if s[2]]
    print(f"\nTOTAL: {len(summary)} (task,rule) combos, "
          f"{len(bad)} with WRONG proposes")
    for b in bad:
        print(f"  WRONG: {b[0]} {b[1]}")


KIND_NAME = ['twins', 'wings', 'missing', 'extra', 'no-wings', 'arms-legs',
             '2-eyes', 'stripes', 'upside-down', 'side', 'size', 'body']


def cmd_task(i):
    """Forensic dump of one scene: truth + every run's signals + gate outcomes."""
    data = load()
    e = data.get(str(i))
    if not e:
        print(f"scene {i}: no data")
        return
    print(f"scene {i} '{LABELS[i]['title']}'  TRUTH={TRUTH[i]}  "
          f"{len(e['runs'])} runs")
    for ri, run in enumerate(e['runs']):
        v = run.get('verdict') or {}
        bits = ' '.join(f"{k}={v.get(k)}" for k in ('G0', 'G1', 'B7', 'V', 'S2', 'C', 'C2'))
        outs = []
        for rule in CANDS7.get(i, []):
            fn, _n = V7_RULES[rule]
            try:
                m = fn({k: _v(run, k) for k in ('G0', 'G1', 'B7', 'V', 'S2', 'C', 'C2')},
                       N_BLOCKS)
            except Exception:
                m = None
            if m is not None:
                outs.append(f"{rule}={'OK' if set(m) == set(TRUTH[i]) else 'WRONG' + str(sorted(m))}")
        print(f"  run{ri + 1}: {bits}")
        if outs:
            print(f"          -> {'; '.join(outs)}")


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'score'
    if cmd == 'run':
        cmd_run(int(sys.argv[2]) if len(sys.argv) > 2 else 1)
    elif cmd == 'score':
        cmd_score()
    elif cmd == 'scoreall':
        cmd_scoreall()
    elif cmd == 'task':
        cmd_task(int(sys.argv[2]))
    elif cmd == 'search':
        cmd_search()
    else:
        print(__doc__)
