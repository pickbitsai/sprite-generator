/**
 * Verify that each boss renders from its OWN sheet at the cell the engine
 * expects. Different failure mode from enemies: bosses each have their own
 * sheet (streetBrawler/techBoss/finalBoss), so the bug isn't cross-row
 * bleed but cross-cell bleed within the same sheet — e.g., BOSS1_FRAME_W =
 * 310 pixel reads over a 256-pixel themed cell grid would mix cell 0 with
 * the left edge of cell 1.
 *
 * Check per boss: render in idle state; compare the rendered sprite's
 * color histogram against every cell (row, col) of the boss's assembled
 * sheet. Best match must be the cell the engine SAYS it's reading for
 * idle (row 0, col 0 in our BOSS_LAYOUT). Otherwise the engine is reading
 * the wrong area.
 *
 * Exit 0 on pass, 2 otherwise.
 *
 * Usage: node tools/theme/verify-boss-render.js <theme-id>
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { themeDir, loadThemeConfig, parseThemeIdFromArgs } = require('./lib');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8779;
const MIME = { '.html':'text/html','.js':'text/javascript','.png':'image/png','.mp3':'audio/mp3','.wav':'audio/wav','.ogg':'audio/ogg','.json':'application/json' };

// Boss slot → in-engine boss type string. Order follows config.bosses.
const BOSS_TYPES = ['street_brawler', 'tech_boss', 'final_boss'];
const BOSS_SHEET_KEYS = ['streetBrawler', 'techBoss', 'finalBoss'];

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const p = path.join(ROOT, url === '/' ? 'index.html' : url);
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});

async function rawAt(source, w, h) {
  return sharp(source).ensureAlpha()
    .resize(w, h, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
}

async function histogram(source) {
  const { data, info } = await rawAt(source, 64, 64);
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

// Histogram over ONLY pixels that differ meaningfully from the baseline
// crop (no-boss version of the same scene). Strips out pipes/ground/etc.
// so we compare sprite-pixels against sheet-cell-sprite-pixels rather
// than against sprite + background.
async function histogramSpriteOnly(renderBuf, baselineBuf) {
  const [rd, bd] = await Promise.all([rawAt(renderBuf, 64, 64), rawAt(baselineBuf, 64, 64)]);
  const BINS = 8;
  const h = new Float32Array(BINS * BINS * BINS);
  let total = 0;
  const step = 256 / BINS;
  const N = rd.info.width * rd.info.height;
  const diffThreshold = 30 * 30 * 3; // sum-of-sq across RGB
  for (let i = 0; i < N; i++) {
    const o = i * rd.info.channels;
    const ob = i * bd.info.channels;
    const dr = rd.data[o] - bd.data[ob];
    const dg = rd.data[o + 1] - bd.data[ob + 1];
    const db = rd.data[o + 2] - bd.data[ob + 2];
    const d2 = dr * dr + dg * dg + db * db;
    if (d2 < diffThreshold) continue;
    const r = Math.min(BINS - 1, Math.floor(rd.data[o] / step));
    const g = Math.min(BINS - 1, Math.floor(rd.data[o + 1] / step));
    const b = Math.min(BINS - 1, Math.floor(rd.data[o + 2] / step));
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
  const config = loadThemeConfig(themeId);

  console.log(`[verify-boss-render] theme=${themeId}`);

  // Prepare per-boss sheet cell histograms (ground truth).
  const bossSheets = [];
  for (let i = 0; i < config.bosses.length; i++) {
    const boss = config.bosses[i];
    const sheetPath = path.join(themeDir(themeId), 'assembled', `boss_${boss.id}.png`);
    if (!fs.existsSync(sheetPath)) throw new Error(`missing sheet: ${sheetPath}`);
    const meta = await sharp(sheetPath).metadata();
    const cols = 8; // themed boss sheets are 8-col 256×256
    const cellW = Math.round(meta.width / cols);
    const rows = Math.max(1, Math.round(meta.height / cellW));
    const cellH = cellW;
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r * cellH + cellH > meta.height) continue;
        if (c * cellW + cellW > meta.width) continue;
        const buf = await sharp(sheetPath).extract({ left: c * cellW, top: r * cellH, width: cellW, height: cellH }).png().toBuffer();
        cells.push({ r, c, sig: await histogram(buf) });
      }
    }
    bossSheets.push({ boss, sheetPath, cols, rows, cellW, cellH, cells, slotIndex: i });
    console.log(`  ${boss.id}: ${meta.width}×${meta.height}, ${rows}×${cols} cells`);
  }

  // Boot the game + freeze + render each boss.
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

  // Grab a baseline (no-boss) screenshot of the same crop region once so we
  // can subtract background from each per-boss render.
  const baselineRect = await page.evaluate(() => {
    const g = window.game;
    g.enemies = [];
    g.boss = null;
    if (typeof g.render === 'function') g.render();
    const c = document.getElementById('gameCanvas');
    const cb = c.getBoundingClientRect();
    const cam = g.camera || { x: 0 };
    const sx = 220 - cam.x;
    const sy = 160;
    const scaleX = cb.width / 384;
    const scaleY = cb.height / 224;
    const cw = 90, ch = 110;
    return {
      x: Math.round(cb.left + (sx - cw / 2) * scaleX),
      y: Math.round(cb.top + (sy - ch + 5) * scaleY),
      width: Math.round(cw * scaleX),
      height: Math.round(ch * scaleY),
    };
  });
  const baselineBuf = await page.screenshot({ clip: baselineRect });

  const failures = [];
  for (let i = 0; i < bossSheets.length; i++) {
    const entry = bossSheets[i];
    const bossType = BOSS_TYPES[i];
    const rect = await page.evaluate(({ bossType }) => {
      const g = window.game;
      g.enemies = [];
      g.boss = null;
      // eslint-disable-next-line no-undef
      const b = new Boss(bossType, 220, 160);
      b.state = 'idle'; b.stateTimer = 999; b.animFrame = 0; b.facing = -1;
      g.boss = b;
      g.enemies.push(b);
      if (typeof g.render === 'function') g.render();
      const c = document.getElementById('gameCanvas');
      const cb = c.getBoundingClientRect();
      const cam = g.camera || { x: 0 };
      const sx = b.x - cam.x;
      const sy = b.y;
      const scaleX = cb.width / 384;
      const scaleY = cb.height / 224;
      // Tight crop around the drawn sprite.
      const cw = 90, ch = 110;
      return {
        x: Math.round(cb.left + (sx - cw / 2) * scaleX),
        y: Math.round(cb.top + (sy - ch + 5) * scaleY),
        width: Math.round(cw * scaleX),
        height: Math.round(ch * scaleY),
      };
    }, { bossType });
    const buf = await page.screenshot({ clip: rect });
    // Sprite-only histogram: keep just pixels that differ from the no-boss
    // baseline. Strips game background out of the comparison.
    const renderSig = await histogramSpriteOnly(buf, baselineBuf);

    if (renderSig.total < 50) {
      console.log(`  FAIL ${entry.boss.id.padEnd(20)} rendered fewer than 50 sprite pixels over baseline (${renderSig.total}) — sprite may not be drawing`);
      failures.push({ boss: entry.boss.id, actual: 'no-sprite-visible' });
      continue;
    }
    // Nearest cell on this boss's sheet.
    let best = null, bestD = Infinity;
    for (const cell of entry.cells) {
      const d = chiSq(renderSig.h, cell.sig.h);
      if (d < bestD) { bestD = d; best = cell; }
    }
    // Expected idle cell from BOSS_LAYOUT (see tools/theme/assemble.js):
    //   idle:    { row: 0, startCol: 0, count: 3 }
    // so idle should render from (0, 0).
    const ok = best && best.r === 0 && best.c === 0;
    const tag = ok ? 'OK' : 'FAIL';
    console.log(`  ${tag.padEnd(4)} ${entry.boss.id.padEnd(20)} expected (0,0) d=${(entry.cells.find(c => c.r === 0 && c.c === 0)?.sig ? chiSq(renderSig.h, entry.cells.find(c => c.r === 0 && c.c === 0).sig.h).toFixed(3) : '?')} | nearest (${best?.r},${best?.c}) d=${bestD.toFixed(3)}`);
    if (!ok) failures.push({ boss: entry.boss.id, actual: best ? `(${best.r},${best.c})` : 'none' });
  }

  if (pageErrors.length) {
    console.log('[verify-boss-render] page errors:');
    pageErrors.forEach(e => console.log('  ' + e));
  }

  await browser.close();
  server.close();

  if (failures.length) {
    console.log(`[verify-boss-render] FAILED — ${failures.length} boss(es) render from wrong cell.`);
    console.log(`  Likely cause: BOSS*_FRAME_W/H in src/sprites.js don't match the themed sheet's 256×256 grid. Ensure window.THEME.bossFrameW/bossFrameH are emitted by build-config.js and consumed in src/boss.js.`);
    process.exit(2);
  }
  console.log('[verify-boss-render] PASSED — every boss idle renders from cell (0,0) of its own sheet.');
}

if (require.main === module) {
  main().catch(e => { console.error('[verify-boss-render] CRASHED:', e.message); process.exit(1); });
}

module.exports = { main };
