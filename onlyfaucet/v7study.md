# v7 CAPTCHA study — "Every captcha gives you a different task"

Source: `https://onlyfaucet.com/mcaptchav7.html` (saved: `/tmp/onlyfaucet-shots/mcaptchav7.html`),
fetched 2026-10-12. 12 practice cards, answers embedded in page JS
(`Z = [[[x,y,r],...]` per card, W=450 H=280). Extracted battery:
`v7/mctut12/` (12 hints + 12 scenes + `mctut12.json` labels).

## Task semantics

Header: **"Every captcha gives you a different task. There are always exactly 2 right
monsters."** Steps: read the task (yellow words) → look at the small picture next to it
(it shows what the task means) → tap the 2 monsters → Verify. **Colour and face never
count** (general rule; task-specific exceptions below).

| # | Task (yellow words) | Sub | Family | Reference needed |
|---|---|---|---|---|
| 0 | Tap its 2 **TWINS** | Same parts as this one | ref | hint = ref monster |
| 1 | same **WINGS** | Only the wings count | ref | hint = ref monster |
| 2 | copies with a part **MISSING** | ref minus one part | ref | hint = ref monster |
| 3 | copies with an **EXTRA PART** | ref plus one part | ref | hint = ref monster |
| 4 | **NO WINGS** | all others have wings | presence | hint = illustration |
| 5 | **ARMS** and **LEGS** | they have both | presence | hint = illustration |
| 6 | **2 EYES** | count the eyes | detail | hint = illustration |
| 7 | **STRIPES** | only body pattern counts | detail | hint = illustration |
| 8 | **UPSIDE DOWN** | standing on their heads | detail | hint = illustration |
| 9 | **LYING ON THEIR SIDE** | not standing up | detail | hint = illustration |
| 10 | the **BIGGEST** and the **SMALLEST** | one big, one small | size | hint = big+small pair |
| 11 | a **DIFFERENT BODY** | body shape unlike the others | detail | hint = shape pair |

Notes:

- twins/wings/missing/extra = v6's 4-category model (top/arms/legs/wings closed
  vocab — see v6study.md) applied against the hint picture;
  missing = exactly one category becomes "nothing/no X"; extra = exactly one
  category gains something where the hint says "nothing/no X".
- #10 is asymmetric: the answer is ONE big + ONE smallest (radii in `Z` confirm:
  40.8 vs 20.6 — clear bimodal size).
- #11 needs global context (2 outliers vs the majority body shape).

## Geometry

- scene 450×280, 8 monsters in a clean **2×4 grid** → 8 blocks of 112×140
  (verified: all 24 answers land in distinct blocks, every truth block contains a
  monster). Hint 150×110 (= v6 ref geometry).
- `seg6` (v6 noise filter) transfers: mean 13.3 cells, **24/24 answers inside a cell**
  (extra cells are background noise — same as v6).

## Solver design (`v7solve.py`)

**Gate philosophy (adopted after prompt-sensitivity experiments):** gemma4:31b answers
flip with tiny prompt/presentation changes, and several scenes have *systematic* errors
that no sample/majority fixes (e.g. upside-down scene: every scene-level call returns the
same wrong pair). So: each task uses only its empirically most-reliable signal (chosen
from battery runs) and **proposes ONLY when that signal yields exactly 2 — otherwise it
bails** (`ok=false`). A bail is FREE live: no Verify, no attempt burned, immediate retry
gets a fresh scene (per the user's standing retry policy). Wrong-proposes are what cost.

Signals (block-level sets over 8 blocks of the 450×280 scene):

- **G0/G1** (scene calls): full scene with drawn 1..8 position labels + hint picture +
  task → `{"match":[..]}`. G1 uses a random label permutation (decorrelates from G0).
- **B7** (ref/presence): one grid call classifying hint+cells with the v6 4-cat vocab →
  deterministic per-kind rule (all-same / wings-equal / missing-one / extra-one /
  no-wings / arms&legs).
- **C / C2** (detail): per **block-champion** tight crop with kind-specific structured
  output. Stripes runs TWO deliberately-different wordings (A: inline vocab,
  B: bulleted "describe with EXACTLY one value") — they make different FP sets while
  sharing the true cells, so the gate uses **A ∩ B**. Upsside-down C was dropped
  (see failure anatomy).

Per-task gates (`TASK_RULE`, all exactly-2-or-bail — never fall back):

| task | gate | evidence |
|---|---|---|
| twins | `B7-exact2` | B7 exact every run; G returns a wrong pair every run |
| wings, 2-eyes, side, size, body | `G-inter-exact2` (G0==G1) | G correct every run; B7/C unreliable there |
| no-wings, arms-legs | `maj2GB-exact2` | all three strong; maj2 absorbs G1's rare miss |
| missing | `GB-agree` (G0==G1 AND ==B7) | signals proven contradictory on tut2 → effectively always bails |
| extra | `G0B-contain` (G0 exact-2 AND B7 ⊇ G0) | G0 flips `[5,6]`/`[2,6]` across runs; B7 containment rejects the hallucinated pair; fires only on alignment, 0 wrong when it fires |
| stripes | `C-inter-exact2` (C_A ∩ C_B) | G always wrong; A=[0,2,3], B=[0,3,4,6]-style disjoint FPs → intersection = truth every run |
| upside-down | `never` | G stable-wrong, anchored-G stable-wrong, C exact-2 outcomes wrong — no discriminator exists → always bail |

Failure anatomy worth remembering (documented with zoom crops):

- *stripes*: truth often includes a monster with faint **segment lines** (brown scene 7);
  spots/edge-shading cause FPs. `striped|spots|plain` vocab + lenient band wording was
  the only variant that ever caught the faint one (recall), strictness traded it away.
- *upside-down*: faces stay upright, so the ONLY cue is feet-vs-face placement; the model
  misassigns "feet" on some monsters (pink mitts, leaf-toppers) **consistently** — all
  prompts (legs-position, inventory, pose-match, CoT describe-then-decide, grid
  comparative) return the same wrong sets at temp=0, and temp=0.7 just flips to a
  different wrong attractor. Hence gate-and-bail rather than ever guessing.

Battery: `python3 eval_v7.py run [K]` / `score` / `search` → `battery-v7-mctut12.json`
(untracked). `score` lists each rule standalone per run; operational results are the
`TASK_RULE` composition — report via the per-task gate analysis (r5: 27/27, see Status).

## Live integration plan (NOT wired yet — perfect offline first)

User instruction 2026-10-12: **"study it … perfect it there before we use it on real
account"** — no live rounds until the battery is won.

When the live card is observed (expected: task title + hint img + scene in
`/faucet/captcha_image` payload or card DOM):

1. detection: card text = one of the 12 task titles (`Tap the 2 ...` patterns;
   distinguish from v6 `Find its twins`); add `st.v7`, route solver
   `v7solve.py --files scene hint "TITLE"` with `nT === 2` guard (mirror of the v6
   wiring in commit `9fdbade`).
2. payload: expect `{scene, ref/hint}` like v6 (verify on first capture).
3. keep the 20-min block policy / immediate retry unchanged.

## Status

- 2026-10-12: page studied, 12 examples + labels extracted (`v7/mctut12/`),
  `seg6` validated (24/24 coverage), `v7solve.py` + `eval_v7.py` built.
  Bot stopped; nothing wired; no live use.
- 2026-10-12 battery runs r1→r5 (K=3 each, verdict forensics on every failure;
  annotated zoom crops of the stubborn monsters saved under
  `/tmp/onlyfaucet-shots/`): prompt-sensitivity measured (tiny wording changes
  flip answers; temp>0 just swaps wrong attractors), so the solver was redesigned
  from majority-votes to **per-task exact-2 gates with bail-on-doubt**.
- **Final battery r5 (K=3): 27/27 propose precision = 100%, 0 wrong-proposes,
  9/12 tasks propose correctly every run, 9 bails (3 tasks × 3 runs).**
  - propose 3/3 correct: twins (B7), wings / 2-eyes / side / size / body
    (G-inter), no-wings / arms-legs (maj2GB), stripes (C_A ∩ C_B intersection).
  - always bail (documented capability limits of gemma4:31b):
    *missing* (signals proven contradictory on tut2 — G0 stable `[0,3]`,
    B7 stable `[5]`, no boolean rule separates truth from FPs),
    *upside-down* (G stable-wrong `[1,5]`; C exact-2 outcomes were wrong;
    anchored-label G also stable-wrong — no discriminator exists),
    *extra* (G0 flips between `[5,6]` and `[2,6]` across runs; gate
    `G0-exact2 ∧ B7 ⊇ G0` fires only on alignment — 0/3 in r5, would have
    fired correctly in earlier data; 0 wrong whenever it fires).
  - A bail is FREE live: no Verify, no attempt burned; the standing retry
    policy (immediate retry, fresh scene, 20-min backoff only on ban banners)
    absorbs it.
- **LIVE TEST 2026-10-12 (user approved "test it live"; wiring commit `43fd7e5`):**
  - wiring: `st.v7` detection regex (`Tap (the|its) 2` / `Tap the BIGGEST`),
    title extracted from card innerText → `v7solve.py --files scene ref TITLE`,
    exactly-2-taps guard, bail reason `v7-gate-bail`, capture accepts `ref|hint`.
  - Round results: v6 card → claim ✓; v7 *upside-down* → gate bail, 0 attempts,
    immediate retry ✓ (bail is free live); v7 *BIGGEST/SMALLEST* → G0==G1
    `[1,5]` → 2 taps → Verify → **claim ✓ Claims=362**; block banners handled
    by the standing 20-min ladder ✓.
  - **Gap found live, hotfixed in `43fd7e5`:** the live site serves task kinds
    BEYOND the tutorial's 12 — `Tap the 2 with ARMS and WINGS` was seen; the
    old generic `'wings'` fallback misrouted it → wrong Verify → site block.
    Fix: `parse_task` is now STRICT (unknown title RAISES → bot bails free,
    never guesses) + new deterministic kind `arms-wings` (presence family,
    B7 4-cat rule `arms≠none ∧ wings≠none`, gate `maj2GB-exact2`,
    `TASK_SIGS=('G','B7')`). Verified offline: 14/14 parse cases, unknown
    titles raise; G0/G1/B7 self-consistent `[6,7]` on tut5.
  - Any future unseen title = free bail + exact text in `bot-loop.log`
    (`v7 card title: ...`) → add kind → re-run K=3 battery before/after rule
    changes as before.
- Push blocked: GitHub SSH key `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINgTl30egFRFz8FHptcrFU1twdxDY0ZFvjLIGoX40jHM vps-admin`
  still unregistered by the user (all commits stay local).
