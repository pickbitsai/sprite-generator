/**
 * Cross-reference what the engine RENDERS for each enemy type against what
 * the enemy sheet actually CONTAINS at the corresponding row. Catches
 * "engine reads wrong row" bugs like the ENEMY_FRAME_W mismatch that
 * silently made every row bleed into the next.
 *
 * For each enemy type T (basic/rusher/blocker/thrower/heavy):
 *   1. Headless Playwright: spawn an Enemy(T) and render it in idle state
 *   2. Extract a color histogram from the rendered sprite crop
 *   3. Extract the same histogram from the ACTUAL sheet cell at
 *      (ENEMY_ROW[T], col 0) via sharp
 *   4. Also compute histograms for every OTHER row in the sheet
 *   5. Assert: the rendered sprite's nearest-match row equals the expected
 *      row. If it matches a different row, the engine is reading the wrong
 *      cells — exactly the class of bug we want surfaced.
 *
 * Exit 0 if every type maps to its expected row; 2 otherwise.
 *
 * Usage:  node tools/theme/verify-enemy-render.js <theme-id>
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { themeDir, parseThemeIdFromArgs } = require('./lib');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8778;
const MIME = { '.html':'text/html','.js':'text/javascript','.png':'image/png','.mp3':'audio/mp3','.wav':'audio/wav','.ogg':'audio/ogg','.json':'application/json' };

const ENEMY_ROW_ORDER = ['basic', 'rusher', 'blocker', 'thrower', 'heavy'];

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const p = path.join(ROOT, url === '/' ? 'index.html' : url);
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});

// 8-bucket-per-channel RGB histogram over opaque pixels (512 bins).
async function histogram(source) {
  const { data, info } = await sharp(source)
    .ensureAlpha()
    .resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const BINS = 8;
  const h = new Float32Array(BINS * BINS * BINS);
  let total = 0;
  const step = 256 / BINS;
  for (let i = 0; i < info.width * info.height; i++) {
    const o = i * info.channels;
    if (data[o + 3] < 50) continue;
    const r = Math.min(BINS - 1, Math.floor(data[o] / step));
    const g = Math.min(BINS - 1, Math.floor(data[o + 1] / step));
    const b = Math.min(BINS - 1, Math.floor(data[o + 2] / step));
    h[r * BINS * BINS + g * BINS + b]++;
    total++;
  }
  if (total > 0) for (let i = 0; i < h.length; i++) h[i] /= total;
  return { h, total };
}

function chiSq(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const sum = a[i] + b[i];
    if (sum <= 0) continue;
    const d = a[i] - b[i];
    s += (d * d) / sum;
  }
  return s;
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const sheetPath = path.join(themeDir(themeId), 'assembled', 'enemies.png');
  if (!fs.existsSync(sheetPath)) throw new Error('enemies sheet missing: ' + sheetPath);

  console.log(`[verify-enemy-render] theme=${themeId}`);

  // Signatures of each row from the actual sheet (ground truth).
  const meta = await sharp(sheetPath).metadata();
  const rows = Math.round(meta.height / (meta.width / 8));
  const cellW = Math.round(meta.width / 8);
  const cellH = Math.round(meta.height / rows);
  const rowSigs = [];
  for (let r = 0; r < rows; r++) {
    const cellBuf = await sharp(sheetPath).extract({ left: 0, top: r * cellH, width: cellW, height: cellH }).png().toBuffer();
    rowSigs.push(await histogram(cellBuf));
  }
  console.log(`  sheet: ${meta.width}×${meta.height}, ${rows} rows × ${cellW}×${cellH} cells`);

  // Boot the game + freeze + capture each enemy type's rendered crop.
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });

  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  await page.goto(`http://localhost:${PORT}/index.html?theme=${themeId}`);
  await page.waitForFunction(() => window.game && window.game.spritesReady, { timeout: 20000 });
  await page.locator('body').click({ force: true }).catch(() => {});
  async function tap(k) { await page.keyboard.down(k); await page.waitForTimeout(110); await page.keyboard.up(k); await page.waitForTimeout(110); }
  await tap('Enter'); await tap('Enter');
  await page.waitForFunction(() => window.game.scene === 'playing', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const g = window.game;
    g.__frozenUpdate = g.update; g.update = () => {};
    if (g.player) { g.player.__frozenUpdate = g.player.update; g.player.update = () => {}; }
  });

  const failures = [];
  const verdicts = [];

  for (let expected = 0; expected < ENEMY_ROW_ORDER.length; expected++) {
    const typeKey = ENEMY_ROW_ORDER[expected];
    const rect = await page.evaluate(({ typeKey }) => {
      const g = window.game;
      g.enemies = [];
      // eslint-disable-next-line no-undef
      const e = new Enemy(ENEMY_TYPES[typeKey], 220, 160);
      e.state = 'idle'; e.stateTimer = 999; e.animFrame = 0; e.facing = -1;
      g.enemies.push(e);
      if (typeof g.render === 'function') g.render();
      const c = document.getElementById('gameCanvas');
      const cb = c.getBoundingClientRect();
      const cam = g.camera || { x: 0 };
      const sx = e.x - cam.x;
      const sy = e.y;
      const scaleX = cb.width / 384;
      const scaleY = cb.height / 224;
      // Tight crop around the drawn sprite (roughly fw*scale = 256*0.20 ≈
      // 52 game px). Minimizing background in the crop lets the sprite's
      // own palette dominate the histogram — otherwise pipes/ground colours
      // pull every type's render toward the same background-matched row.
      const cw = 46, ch = 50;
      return {
        x: Math.round(cb.left + (sx - cw / 2) * scaleX),
        y: Math.round(cb.top + (sy - ch) * scaleY),
        width: Math.round(cw * scaleX),
        height: Math.round(ch * scaleY),
      };
    }, { typeKey });
    const buf = await page.screenshot({ clip: rect });
    const renderSig = await histogram(buf);

    // Find nearest row.
    let bestRow = -1, bestD = Infinity;
    const dists = rowSigs.map((rs, r) => {
      const d = chiSq(renderSig.h, rs.h);
      if (d < bestD) { bestD = d; bestRow = r; }
      return { r, d };
    });
    const ok = bestRow === expected;
    const expectedD = dists[expected].d;
    verdicts.push({ typeKey, expected, bestRow, bestD, expectedD, ok });
    const tag = ok ? 'OK' : 'FAIL';
    const dStr = `expected row=${expected} d=${expectedD.toFixed(3)} | nearest row=${bestRow} d=${bestD.toFixed(3)}`;
    console.log(`  ${tag.padEnd(4)} ${typeKey.padEnd(8)} ${dStr}`);
    if (!ok) failures.push({ typeKey, expected, bestRow });
  }

  if (pageErrors.length) {
    console.log('[verify-enemy-render] page errors:');
    pageErrors.forEach(e => console.log('  ' + e));
  }

  await browser.close();
  server.close();

  if (failures.length) {
    console.log(`[verify-enemy-render] FAILED — ${failures.length} type(s) render wrong row.`);
    console.log(`  Most likely cause: engine reads with base-game ENEMY_FRAME_W/H but the themed sheet uses 256×256. Ensure window.THEME.enemyFrameW/enemyFrameH are set in theme.js and consumed in src/enemy.js.`);
    process.exit(2);
  }
  console.log('[verify-enemy-render] PASSED — every enemy type renders from its expected sheet row.');
}

if (require.main === module) {
  main().catch(e => { console.error('[verify-enemy-render] CRASHED:', e.message); process.exit(1); });
}

module.exports = { main };
