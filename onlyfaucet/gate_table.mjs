// Offline gate table: run find_chain.py + the REAL consensusGate (imported from
// bot.mjs) over every captured sample and report pass/reject per sample.
// Touches the site in no way — this is the regression test for gate thresholds.
//
//   node gate_table.mjs
//
// Samples live in $SHOT_DIR (default /tmp/onlyfaucet-shots):
//   truth*-bg / truth*-widget  native bg + scaled widget shot of 5 puzzles
//   bg-*/verify-*              3 more puzzles captured by verify_chain.mjs
// `correct` marks the reads verified against the truth captures (score_fit.py
// outline coverage 0.88-0.98, i.e. the target really is the dash chain).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { consensusGate } from './bot.mjs';

const SHOTS = process.env.SHOT_DIR || '/tmp/onlyfaucet-shots';
const RECT = '2,2,402,250';   // host box => canvas inset (border+padding)

// name, bg/widget file, sprite, geom (canvas), rect, correct?
const SAMPLES = [
  ['T1-bg', 'truth-bg.png', 'truth-sprite.png', '81,211', null, true],
  ['T2-bg', 'truth2-bg.png', 'truth2-sprite.png', '58,120', null, true],
  ['T3-bg', 'truth3-bg.png', 'truth3-sprite.png', '57,125', null, true],
  ['T4-bg', 'truth4-bg.png', 'truth4-sprite.png', '59,68', null, true],
  ['T5-bg', 'truth5-bg.png', 'truth5-sprite.png', '71,82', null, true],
  ['V1-bg', 'bg-1790433377678.png', 'sprite-1790433377185.png', '74,117', null, true],
  ['V2-bg', 'bg-1790434101916.png', 'sprite-1790434101889.png', '59,59', null, true],
  ['V3-bg', 'bg-1790434191121.png', 'sprite-1790434190619.png', '51,160', null, true],
  ['T1-w', 'truth-widget.png', 'truth-sprite.png', '81,211', RECT, true],
  ['T2-w', 'truth2-widget.png', 'truth2-sprite.png', '58,120', RECT, true],
  ['T3-w', 'truth3-widget.png', 'truth3-sprite.png', '57,125', RECT, false],
  ['T4-w', 'truth4-widget.png', 'truth4-sprite.png', '59,68', RECT, true],
  ['T5-w', 'truth5-widget.png', 'truth5-sprite.png', '71,82', RECT, true],
  ['V1-w', 'verify-2026-09-26T14-36-20-471Z.png', 'sprite-1790433377185.png', '74,117', RECT, true],
  ['V2-w', 'verify-2026-09-26T14-48-24-948Z.png', 'sprite-1790434101889.png', '59,59', RECT, true],
  ['V3-w', 'verify-2026-09-26T14-49-53-814Z.png', 'sprite-1790434190619.png', '51,160', RECT, true],
];

let rightPass = 0, rightN = 0, wrongN = 0, wrongPass = 0;
const bad = [];
for (const [name, img, spr, geom, rect, correct] of SAMPLES) {
  const ip = join(SHOTS, img), sp = join(SHOTS, spr);
  if (!existsSync(ip) || !existsSync(sp)) { console.log(`${name}: missing sample`); continue; }
  const argv = ['python3', join(import.meta.dirname, 'find_chain.py'), ip,
    '--sprite', sp, '--geom', geom];
  if (rect) argv.push('--rect', rect);
  let d;
  try {
    d = JSON.parse(execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 60000 }));
  } catch (e) {
    console.log(`${name}: detector error ${String(e.message).slice(0, 100)}`); continue;
  }
  d.detector = 'chain';
  d.input = rect ? 'shot' : 'bg';
  const g = consensusGate(d, null, 450, 280);   // vision=null: chain leads anyway
  const verdict = correct
    ? (g.chainClear ? 'pass' : 'REJECT(correct)')
    : (g.chainClear ? 'PASS(WRONG)' : 'reject');
  if (correct) { rightN++; if (g.chainClear) rightPass++; else bad.push(name); }
  else { wrongN++; if (g.chainClear) { wrongPass++; bad.push(name); } }
  console.log(`${name.padEnd(6)} gate=${g.gate.padEnd(12)} z=${String(d.z).padEnd(5)} `
    + `m=${String(d.margin).padEnd(6)} sup=${String(d.support).padEnd(3)} `
    + `iou=${String(d.iou0).padEnd(5)} cover=${String(d.cover).padEnd(5)} => ${verdict}`);
}
console.log(`\ncorrect pass ${rightPass}/${rightN}   wrong rejected ${wrongN - wrongPass}/${wrongN}`
  + (bad.length ? `   FAILURES: ${bad.join(', ')}` : '   ALL GOOD'));
process.exit(bad.length ? 1 : 0);
