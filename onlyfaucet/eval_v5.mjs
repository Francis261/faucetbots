// eval_v5.mjs — evaluate VLM solving of the v5 creature captcha against the
// 20 labeled tutorial examples (tutorial20.json: scene/ref data-URLs + zones).
//
// Usage: node eval_v5.mjs [count] [offset]   (default: all 20)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const VISION_HOST = 'https://ollama.com';
const VISION_KEY = '9d800d83a8854b12afc5739fc7e6f691.R5TP5sR4H-LhTgMTvZgx7-OK';
const VISION_MODEL = 'gemma4:31b';   // works via /v1/chat/completions (OpenAI-compat)

const R = JSON.parse(readFileSync('/tmp/onlyfaucet-shots/tutorial20.json', 'utf8'));
const COUNT = Number(process.argv[2]) || R.length;
const OFFSET = Number(process.argv[3]) || 0;
mkdirSync('/tmp/onlyfaucet-shots/eval', { recursive: true });

const b64file = (p) => readFileSync(p).toString('base64');
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const PROMPT = `Two images.
Image 1: a scene, 450x280 pixels, containing many small hand-drawn cartoon creatures.
Image 2: ONE reference creature, cut out.

Find every creature in the scene that is BUILT THE SAME WAY as the reference creature:
same body shape, same wings, same legs, same head, same tail.
Colour, pattern, size, pose and facing direction DO NOT matter.
Near misses that differ in any one of those five parts must NOT be included.

Answer with ONLY a JSON object: {"matches":[{"x":<pixels>,"y":<pixels>},...]}
x is horizontal (0-450), y is vertical (0-280). Coordinates are creature CENTERS.
List at most 6 matches.`;

async function ask(sceneB64, refB64, tag) {
  const t0 = Date.now();
  const res = await fetch(`${VISION_HOST}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VISION_KEY}` },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${sceneB64}` } },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${refB64}` } },
        ],
      }],
      stream: false, max_tokens: 400,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(90000),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`vision ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = (data.choices?.[0]?.message?.content || '').trim();
  writeFileSync(`/tmp/onlyfaucet-shots/eval/${tag}.raw.txt`, content);
  let parsed = null;
  try { parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || content); } catch {}
  return { matches: (parsed?.matches || []).map((m) => ({ x: +m.x, y: +m.y })), ms };
}

const results = [];
for (let i = OFFSET; i < Math.min(R.length, OFFSET + COUNT); i++) {
  const ex = R[i];
  const tag = `i${String(i).padStart(2, '0')}`;
  try {
    const { matches, ms } = await ask(
      b64file(`/tmp/onlyfaucet-shots/tut${String(i).padStart(2, '0')}-scene.png`),
      b64file(`/tmp/onlyfaucet-shots/tut${String(i).padStart(2, '0')}-ref.png`), tag);
    // hit = matched to a true zone; each zone needs one hit; leftover taps = FP
    const used = new Set();
    let hits = 0;
    for (const z of ex.zones) {
      let best = Infinity, bi = -1;
      matches.forEach((m, mi) => {
        if (used.has(mi)) return;
        const d = dist(m, { x: z[0], y: z[1] });
        if (d < best) { best = d; bi = mi; }
      });
      if (bi >= 0 && best <= 30) { used.add(bi); hits++; }
    }
    const fps = matches.length - hits;
    // would we also hit the trap/near? (false-positive danger check)
    const nearHit = ex.near.some((n) => matches.some((m) => dist(m, { x: n[0], y: n[1] }) <= 30));
    const ok = hits === ex.zones.length && fps === 0 && !nearHit;
    results.push({ i, hits, need: ex.zones.length, fps, nearHit, ms, ok });
    console.log(`${tag} ${ok ? 'PASS' : 'FAIL'} hits=${hits}/${ex.zones.length} fps=${fps} nearHit=${nearHit} ${ms}ms taps=${JSON.stringify(matches)}`);
  } catch (e) {
    results.push({ i, error: String(e.message).slice(0, 120) });
    console.log(`i${String(i).padStart(2, '0')} ERROR ${e.message.slice(0, 120)}`);
  }
}
const pass = results.filter((r) => r.ok).length;
console.log(`\n=== ${pass}/${results.length} strict-pass; avg ${Math.round(results.filter(r=>r.ms).reduce((s,r)=>s+r.ms,0)/Math.max(1,results.filter(r=>r.ms).length))}ms`);
