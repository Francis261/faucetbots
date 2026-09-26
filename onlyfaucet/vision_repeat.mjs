// How repeatable is the vision detector? Runs N passes on saved screenshots and
// reports pairwise distances — this is the confidence signal the gate leans on.
import { readFileSync } from 'node:fs';
import { analyzePuzzle, findHolePy, log } from './bot.mjs';

const N = Number(process.env.PASSES || 3);
const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('usage: node vision_repeat.mjs <puzzle.png> [...]');
  process.exit(1);
}

for (const p of paths) {
  const buf = readFileSync(p);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const holeDet = findHolePy(p);
  const piece = { x: holeDet?.pieceX ?? width / 2, y: holeDet?.pieceY ?? height / 2 };
  log(`\n=== ${p} (${width}x${height}) piece=(${piece.x},${piece.y})`);
  const runs = [];
  for (let i = 0; i < N; i++) {
    try {
      const v = await analyzePuzzle(buf, width, height);
      runs.push(v);
      log(`  pass${i}: target=(${v.targetX?.toFixed(0)},${v.targetY?.toFixed(0)}) piece=(${v.pieceX?.toFixed(0)},${v.pieceY?.toFixed(0)})`);
    } catch (e) {
      log(`  pass${i}: error ${e.message.slice(0, 100)}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  let worst = 0;
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i], b = runs[j];
      if (a.targetX == null || b.targetX == null) continue;
      const d = Math.hypot(a.targetX - b.targetX, a.targetY - b.targetY);
      worst = Math.max(worst, d);
      log(`  dist pass${i}-pass${j} = ${d.toFixed(1)}px`);
    }
  }
  const pyBest = holeDet?.cands?.[0];
  if (pyBest && runs[0]) {
    const d = Math.hypot(pyBest.x - runs[0].targetX, pyBest.y - runs[0].targetY);
    log(`  cv-vs-vision0 = ${d.toFixed(1)}px  cv=(${pyBest.x},${pyBest.y})`);
  }
  log(`  worst pairwise distance = ${worst.toFixed(1)}px => ${worst <= 25 ? 'CONSISTENT' : 'UNSTABLE'}`);
}
