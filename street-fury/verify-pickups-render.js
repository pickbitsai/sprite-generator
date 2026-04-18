/**
 * Pickups and destructibles share the base items.png sheet between base
 * and themed games. If a theme's regridConfig silently drops the `items`
 * entry (or any other shared base sheet), the themed render pulls from
 * unregridded pixel positions and pickup sprites come out wrong — e.g.,
 * a trashcan appears as debris, a barrel as a dust cloud.
 *
 * This gate catches it: spawn each pickup both IN-BASE and IN-THEME,
 * crop a tight sprite-region, subtract the per-run baseline background,
 * and compare the two sprite-only histograms with chi-squared distance.
 * Shared sheets should render near-identically — if they don't, the
 * regrid/theme config dropped a key.
 *
 * Exit 0 on pass (all pickup types match within threshold), 2 otherwise.
 *
 * Usage: node tools/theme/verify-pickups-render.js <theme-id>
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { parseThemeIdFromArgs } = require('./lib');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8783;
const MIME = { '.html':'text/html','.js':'text/javascript','.png':'image/png','.mp3':'audio/mp3','.wav':'audio/wav','.ogg':'audio/ogg','.json':'application/json' };

const ITEMS = [
  { kind: 'item',         type: 'food_small' },
  { kind: 'item',         type: 'food_large' },
  { kind: 'item',         type: 'oneup' },
  { kind: 'item',         type: 'weapon_pipe' },
  { kind: 'destructible', type: 'trashcan' },
  { kind: 'destructible', type: 'crate' },
  { kind: 'destructible', type: 'barrel' },
  { kind: 'destructible', type: 'barrel2' },
];

// Chi-squared distance threshold above which the themed render is
// considered divergent from base. Same sheet + same sprite should land
// well under this (empirical: < 0.15). Genuinely-themed items could
// exceed it legitimately, so future per-theme pickup themes would flip
// this off or supply their own ground truth.
const MAX_DIVERGENCE = 0.35;

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

async function histogramSpriteOnly(renderBuf, baselineBuf) {
  const [rd, bd] = await Promise.all([rawAt(renderBuf, 48, 48), rawAt(baselineBuf, 48, 48)]);
  const BINS = 8;
  const h = new Float32Array(BINS * BINS * BINS);
  let total = 0;
  const step = 256 / BINS;
  const N = rd.info.width * rd.info.height;
  const threshold2 = 30 * 30 * 3;
  for (let i = 0; i < N; i++) {
    const o = i * rd.info.channels;
    const ob = i * bd.info.channels;
    const dr = rd.data[o] - bd.data[ob];
    const dg = rd.data[o + 1] - bd.data[ob + 1];
    const db = rd.data[o + 2] - bd.data[ob + 2];
    if (dr * dr + dg * dg + db * db < threshold2) continue;
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

async function bootAndFreeze(page, themeId) {
  const url = `http://localhost:${PORT}/index.html${themeId ? '?theme=' + themeId : ''}`;
  await page.goto(url);
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
}

async function captureBaseline(page) {
  return page.evaluate(() => {
    const g = window.game;
    g.items = []; g.destructibles = []; g.enemies = [];
    if (typeof g.render === 'function') g.render();
    const c = document.getElementById('gameCanvas');
    const cb = c.getBoundingClientRect();
    const cam = g.camera || { x: 0 };
    const sx = 220 - cam.x, sy = 170;
    const scaleX = cb.width / 384, scaleY = cb.height / 224;
    const cw = 34, ch = 40;
    return {
      x: Math.round(cb.left + (sx - cw / 2) * scaleX),
      y: Math.round(cb.top + (sy - ch + 8) * scaleY),
      width: Math.round(cw * scaleX),
      height: Math.round(ch * scaleY),
    };
  }).then(rect => page.screenshot({ clip: rect }).then(buf => ({ rect, buf })));
}

async function captureItem(page, baselineRect, kind, type) {
  await page.evaluate(({ kind, type }) => {
    const g = window.game;
    g.items = []; g.destructibles = []; g.enemies = [];
    const X = 220, Y = 170;
    let obj;
    if (kind === 'item') {
      // eslint-disable-next-line no-undef
      obj = new Item(type, X, Y);
      obj.grounded = true; obj.vz = 0; obj.z = 0; obj.animTimer = 20;
      g.items.push(obj);
    } else {
      // eslint-disable-next-line no-undef
      obj = new Destructible(type, X, Y, []);
      obj.shakeTimer = 0;
      g.destructibles.push(obj);
    }
    if (typeof g.render === 'function') g.render();
  }, { kind, type });
  return page.screenshot({ clip: baselineRect });
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  console.log(`[verify-pickups-render] theme=${themeId}  maxDivergence=${MAX_DIVERGENCE}`);

  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ headless: true });

  // Base run first to establish ground-truth histograms.
  const basePage = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await bootAndFreeze(basePage, '');
  const base = await captureBaseline(basePage);
  const baseSigs = {};
  for (const entry of ITEMS) {
    const render = await captureItem(basePage, base.rect, entry.kind, entry.type);
    baseSigs[entry.type] = await histogramSpriteOnly(render, base.buf);
  }
  await basePage.close();

  // Themed run.
  const themePage = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await bootAndFreeze(themePage, themeId);
  const themeBase = await captureBaseline(themePage);

  const failures = [];
  for (const entry of ITEMS) {
    const render = await captureItem(themePage, themeBase.rect, entry.kind, entry.type);
    const themeSig = await histogramSpriteOnly(render, themeBase.buf);
    const d = chiSq(baseSigs[entry.type].h, themeSig.h);
    const ok = d <= MAX_DIVERGENCE;
    const tag = ok ? 'OK' : 'FAIL';
    console.log(`  ${tag.padEnd(4)} ${entry.kind.padEnd(13)} ${entry.type.padEnd(12)} d=${d.toFixed(3)}  (base sprite-px=${baseSigs[entry.type].total}, theme sprite-px=${themeSig.total})`);
    if (!ok) failures.push({ type: entry.type, d });
  }

  await themePage.close();
  await browser.close();
  server.close();

  if (failures.length) {
    console.log(`[verify-pickups-render] FAILED — ${failures.length} pickup(s) diverge from base render.`);
    console.log(`  Likely cause: theme.regridConfig is missing one of the shared base sheet keys (most often 'items'). sprites.js now merges base + theme configs, so regenerate theme.js with build-config.js and rerun.`);
    process.exit(2);
  }
  console.log('[verify-pickups-render] PASSED — every pickup renders like the base game.');
}

if (require.main === module) {
  main().catch(e => { console.error('[verify-pickups-render] CRASHED:', e.message); process.exit(1); });
}

module.exports = { main };
