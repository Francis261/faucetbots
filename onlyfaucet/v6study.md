# v6 CAPTCHA study — "Find its twins"

Source: https://onlyfaucet.com/mcaptchav6.html (noindex tutorial page, same genre as
mcaptchav5.html). Extracted 2026-10-09. Battery: 12 labeled examples -> `v6/mctut12/`
(scene + ref PNGs, `mctut12.json` labels), produced by `extract_mctut12.py`.

## Task semantics (from the page text)

- "Find its twins": tap every monster with the **same parts** as the example, then Verify.
- **All monsters share the same body** — body shape is NOT a discriminator (v5 differences).
- Exactly **4 part categories** count, always:
  1. horns/ears — "what's on top"
  2. arms
  3. legs
  4. wings
- **There are always 2 twins** (confirmed: `zones` length = 2 in all 12 examples).
- Does NOT matter: colour, pattern, face, size, slight lean, wing angle, background pattern.
- **Faces are always different from the example, on purpose** — never match by face.
- Part **kind and count matter**: "two horns and one horn are different".
- Every scene has look-alikes that differ by exactly **one missing / extra / different part**
  (per-decoy `trap` strings: `"decoy-kind instead of ref-kind"`).

## Vocabulary (union of all 12 hints + trap sides)

| category | kinds |
|---|---|
| top    | pointy ears · long bunny ears · a spiky mohawk · one horn · a propeller · a little sprout · antennae · nothing on top  (8) |
| arms   | arms with claws · long arms with hands · tentacle arms · crab pincers · no arms  (5) |
| legs   | four little feet · two feet · long legs · spring legs · tentacle legs · no legs  (6) |
| wings  | butterfly wings · bat wings · dragonfly wings · no wings  (4) |

`antennae` only ever appears on the decoy side of traps (not in any ref hint).

## Example data format (`mctut12.json` entries)

- `zones`: 2 x `[x, y, r]` — the true twins
- `near`: 2 x `[x, y, r]` — the labelled look-alike decoys
- `hint`: `[top, arms, legs, wings]` — the ref's four parts
- `trap`: per-decoy list of `"X instead of Y"` strings, index-aligned with `near`

Scenes are 450x280 webp (same canvas as v5), **8 monsters in a 2x4 grid**:
2 twins + 2 look-alikes + 4 fillers. All 12 backgrounds are light
(`cand_v5.candidates` mode=`light` for all).

## Segmentation findings (cand_v5 on all 12 scenes)

- **Coverage: 24/24 twin zones and 24/24 decoy zones map to a candidate** — no misses.
- Over-segments: 17-25 candidates per scene (v5 typical: 8-14) — background doodles and
  monster parts fragment into extra CCs.
- Labeled-monster candidate areas: min 830, p25 2018, p50 2488, max 4410.
  Noise quartiles: p25 535, p50 980.
- Suggested v6 tuning: area filter >= ~700 keeps every labeled monster while dropping the
  small scribble CCs (expect ~12-16 cands/scene); or a merge pass for split parts.

## Solver plan (reuse the v5 pipeline)

1. Segment scene (cand_v5 + area filter above) -> candidate cells.
2. Signals in the proven shape: B = classify ref+cells over the 4 fixed vocab lists,
   E = S/D per cell, E2 second opinion, P2 pairwise same/different — all with v6 prompts
   that list the closed vocabularies above.
3. Rule: safe-union analogue, validated by exhaustive boolean search on the 12-scene
   battery (same methodology as v5's 65,536-rule search).
4. Battery: `eval_mctut6.py` over `v6/mctut12/`, **strict exact-set of 2** (same strict_mc
   standard as v5), 2 runs/scene.
5. Live readiness: bot needs v6 widget detection + scene/ref capture once the live widget
   actually serves v6 (DOM unknown until seen); v5 path stays untouched until then.
   Answer is always exactly 2 taps.

## Status

- 2026-10-09: study complete, battery extracted + committed. Bot stopped (user's "stop it"),
  no live v6 observed yet. Solver build pending.
