#!/usr/bin/env python3
"""run_fs.py — few-shot REF classification (variant B2).

Shows 3 teacher refs with their correct 5-slot classification (from tutorial
hints), then the target ref -> classify. Teaches the vocabulary mapping for
this art style. Dumps to /tmp/onlyfaucet-shots/fs.json.
"""
import json, sys, time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from eval_cv5 import SHOTS, SLOTS
from exp_v5 import ask, big_ref, b64img

TEACHERS = [3, 2, 0]   # spiky/one-long-wing/long-snout/no-tail;
                        # teardrop/two-wings/eyes-on-body/fan-tail;
                        # six-sided/round-wing/long-snout/forked-tail
TARGET = 15             # classify refs for all 20 (target varies)

VOCAB = """- body: bean-shaped body | oval body | six-sided body | spiky body | teardrop body
- wings: a pointed wing | a round wing | no wings | one long wing | two wings
- legs: 2 legs | 4 legs | no legs
- head: a long snout | a round head | no head (eyes on the body)
- tail: a curly tail | a fan tail | a forked tail | a thin tail | no tail"""

PROMPT_FS = """You will see several images of cartoon creature cut-outs.

Image 1, 2 and 3 are EXAMPLES whose correct classification is given below:
Example 1 (Image 1): {t1}
Example 2 (Image 2): {t2}
Example 3 (Image 3): {t3}

Image 4 is the TARGET creature. Classify it the same way, using EXACTLY one value from each list:
""" + VOCAB + """

Judge only construction: body outline shape, wings, leg count, head shape, tail shape. IGNORE colour, colour pattern, size, facing direction, pose, rotation.

Reply ONLY JSON: {"body":"...","wings":"...","legs":"...","head":"...","tail":"..."}"""


def main():
    R = json.load(open(SHOTS / 'tutorial20.json'))
    out_path = SHOTS / 'fs.json'
    results = json.load(open(out_path)) if out_path.exists() else {}
    hint_str = {i: ', '.join(h.lower() for h in R[i]['hint']) for i in TEACHERS}
    prompt = (PROMPT_FS.replace('{t1}', hint_str[TEACHERS[0]])
                       .replace('{t2}', hint_str[TEACHERS[1]])
                       .replace('{t3}', hint_str[TEACHERS[2]]))
    teacher_imgs = []
    for t in TEACHERS:
        ref = cv2.imread(str(SHOTS / f'tut{t:02d}-ref.png'))
        teacher_imgs.append(b64img(__pil(big_ref(ref))))
    for i in range(len(R)):
        if str(i) in results:
            continue
        ref = cv2.imread(str(SHOTS / f'tut{i:02d}-ref.png'))
        imgs = teacher_imgs + [b64img(__pil(big_ref(ref)))]
        t0 = time.time()
        parsed, raw, ms = ask(prompt, imgs, max_tokens=200)
        results[str(i)] = {'slots': parsed, 'ms': ms, 'error': None if parsed else raw[:150]}
        hint = [h.lower() for h in R[i]['hint']]
        acc = None
        if parsed:
            acc = sum(1 for k, h in zip(['body', 'wings', 'legs', 'head', 'tail'], hint)
                      if str(parsed.get(k, '')).strip().lower() == h)
        print(f'ex{i:02d} acc={acc}/5 {ms}ms {parsed}', flush=True)
        json.dump(results, open(out_path, 'w'), indent=1)
    ok = sum(sum(1 for k, h in zip(['body', 'wings', 'legs', 'head', 'tail'],
                                   [x.lower() for x in R[i]['hint']])
                 if (results[str(i)].get('slots') or {}).get(k, '').strip().lower() == h)
             for i in range(len(R)))
    print(f'=== few-shot ref slots {ok}/{5*len(R)}')


def __pil(npimg):
    from PIL import Image
    return Image.fromarray(cv2.cvtColor(npimg, cv2.COLOR_BGR2RGB))


if __name__ == '__main__':
    main()
