// Offline gate check: run CV + vision on already-captured puzzle screenshots and
// print what the confidence gate would decide. Touches the site in no way.
//   node gate_test.mjs /tmp/onlyfaucet-shots/capture-...-0.png ...
import { readFileSync } from 'node:fs';
import { findHolePy, analyzePuzzle, log } from './bot.mjs';

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('usage: node gate_test.mjs <puzzle.png> [...]');
  process.exit(1);
}

const PY_PD_MAX = 0.10;
const PY_MARGIN_MIN = 1.2;

for (const p of paths) {
  const buf = readFileSync(p);
  // Infer clip size from the PNG header (width/height at bytes 16-24).
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  log(`\n=== ${p} (${width}x${height})`);

  const pyPending = Promise.resolve().then(() => findHolePy(p));
  let vision = null;
  try { vision = await analyzePuzzle(buf, width, height); } catch (e) { log(`vision error: ${e.message}`); }
  const holeDet = await pyPending;
  log(`find_hole: ${JSON.stringify(holeDet)}`);
  log(`vision: ${JSON.stringify(vision)}`);

  const pieceX = holeDet?.pieceX ?? vision?.pieceX ?? width / 2;
  const pieceY = holeDet?.pieceY ?? vision?.pieceY ?? height / 2;
  const pyBest = holeDet?.cands?.[0] ?? null;
  const pyCands = holeDet?.cands ?? [];
  const visionOnBoard = vision && vision.targetX != null && vision.targetY != null
    && Math.hypot(vision.targetX - pieceX, vision.targetY - pieceY) >= 15;
  const agreeDist = pyBest && visionOnBoard
    ? Math.hypot(pyBest.x - vision.targetX, pyBest.y - vision.targetY) : null;
  const pyPd = holeDet?.ptdist ?? 1;
  const pyMargin = (pyCands.length > 1 && pyCands[0].score > 0) ? pyCands[1].score / pyCands[0].score : null;
  const pyClear = !!pyBest && pyPd <= PY_PD_MAX && pyMargin != null && pyMargin >= PY_MARGIN_MIN;

  let gate = 'bail';
  if (pyBest && visionOnBoard && agreeDist <= 30) gate = 'agree';
  else if (pyBest && visionOnBoard) gate = 'conflict';
  else if (pyClear) gate = 'py-clear';
  else if (visionOnBoard) gate = 'vision-only(needs self-check)';

  log(`piece=(${pieceX},${pieceY}) pyBest=${pyBest ? `(${pyBest.x},${pyBest.y})` : 'none'} `
    + `vision=${visionOnBoard ? `(${Math.round(vision.targetX)},${Math.round(vision.targetY)})` : 'none'} `
    + `agree=${agreeDist != null ? agreeDist.toFixed(0) : 'n/a'} pd=${pyPd.toFixed(3)} `
    + `margin=${pyMargin != null ? pyMargin.toFixed(2) : 'n/a'} => GATE ${gate}`);
}
