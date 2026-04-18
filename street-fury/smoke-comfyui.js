// Single-frame smoke test for the ComfyUI integration. Picks an existing
// simpsons character frame as a reference and asks ComfyUI for a new pose
// via IP-Adapter. Proves the upload → workflow → poll → download loop works
// end-to-end before we commit to a full theme run.
const fs = require('fs');
const path = require('path');
const { callComfyUI } = require('./lib');

async function main() {
  const ref = path.join(__dirname, '..', '..', 'src', 'themes', 'simpsons', 'chars', 'homer_simpson', 'anim', 'idle_1.png');
  const out = path.join(__dirname, '..', '..', 'test-screenshots', 'comfyui-smoke.png');
  if (!fs.existsSync(ref)) throw new Error(`missing reference: ${ref}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const prompt = '16-bit arcade beat-em-up pixel sprite, the SAME character as the reference image, now in a running pose with left leg extended forward, side-view facing right, plain white background, full body visible, clean outline, vibrant colors, no other characters, no text';

  console.log('[smoke] submitting to ComfyUI — expect ~10-30s on a 3080 Ti');
  const t0 = Date.now();
  const buf = await callComfyUI(fs.readFileSync(ref), prompt, { seed: 42 });
  const ms = Date.now() - t0;
  fs.writeFileSync(out, buf);
  console.log(`[smoke] OK in ${(ms / 1000).toFixed(1)}s → ${path.relative(path.join(__dirname, '..', '..'), out)}  (${buf.length} bytes)`);
}

main().catch(e => { console.error('[smoke] FAILED:', e.message); process.exit(1); });
