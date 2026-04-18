/**
 * Pickups and destructible-objects review grid. Spawns one of each in-game
 * and screenshots the render — required visual export before shipping a
 * theme, same pattern as capture-walks/enemies/bosses. Currently covers
 * Item and Destructible types (see src/entities.js); projectiles and hit
 * effects can be added here later.
 *
 * Usage:
 *   node tools/theme/capture-pickups.js            # base
 *   node tools/theme/capture-pickups.js simpsons
 *
 * Output:
 *   test-screenshots/pickups-<theme|base>-<type>.png
 *   test-screenshots/pickups-<theme|base>-grid.png
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8782;
const MIME = { '.html':'text/html','.js':'text/javascript','.png':'image/png','.mp3':'audio/mp3','.wav':'audio/wav','.ogg':'audio/ogg','.json':'application/json' };

const ITEMS = [
  { kind: 'item',         type: 'food_small',  label: 'Apple (food_small)' },
  { kind: 'item',         type: 'food_large',  label: 'Pizza (food_large)' },
  { kind: 'item',         type: 'oneup',       label: '1-UP' },
  { kind: 'item',         type: 'weapon_pipe', label: 'Weapon: Pipe' },
  { kind: 'destructible', type: 'trashcan',    label: 'Trashcan' },
  { kind: 'destructible', type: 'crate',       label: 'Crate' },
  { kind: 'destructible', type: 'barrel',      label: 'Barrel' },
  { kind: 'destructible', type: 'barrel2',     label: 'Barrel (variant)' },
];

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const p = path.join(ROOT, url === '/' ? 'index.html' : url);
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});

async function main() {
  const themeId = process.argv[2] || '';
  const label = themeId || 'base';
  const outDir = path.join(ROOT, 'test-screenshots');
  fs.mkdirSync(outDir, { recursive: true });

  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const url = `http://localhost:${PORT}/index.html${themeId ? '?theme=' + themeId : ''}`;
  console.log(`[capture-pickups] ${url}`);
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

  const captures = [];
  for (const entry of ITEMS) {
    const rect = await page.evaluate(({ kind, type }) => {
      const g = window.game;
      g.items = [];
      g.destructibles = [];
      g.enemies = [];
      const X = 220, Y = 170;
      let obj;
      if (kind === 'item') {
        // eslint-disable-next-line no-undef
        obj = new Item(type, X, Y);
        obj.grounded = true;  // land it immediately so the bounce doesn't skew the crop
        obj.vz = 0;
        obj.z = 0;
        obj.animTimer = 20;
        g.items.push(obj);
      } else {
        // eslint-disable-next-line no-undef
        obj = new Destructible(type, X, Y, []);
        obj.shakeTimer = 0;
        g.destructibles.push(obj);
      }
      if (typeof g.render === 'function') g.render();
      const c = document.getElementById('gameCanvas');
      const cb = c.getBoundingClientRect();
      const cam = g.camera || { x: 0 };
      const sx = X - cam.x;
      const sy = Y;
      const scaleX = cb.width / 384;
      const scaleY = cb.height / 224;
      const cw = 34, ch = 40;
      return {
        x: Math.round(cb.left + (sx - cw / 2) * scaleX),
        y: Math.round(cb.top + (sy - ch + 8) * scaleY),
        width: Math.round(cw * scaleX),
        height: Math.round(ch * scaleY),
      };
    }, { kind: entry.kind, type: entry.type });
    const out = path.join(outDir, `pickups-${label}-${entry.kind}-${entry.type}.png`);
    await page.screenshot({ path: out, clip: rect });
    captures.push({ ...entry, file: out });
    console.log(`  ${entry.label.padEnd(26)} → ${path.relative(ROOT, out)}`);
  }

  // Grid: 4 columns × 2 rows.
  const cellW = 160, cellH = 180, labelH = 24, gap = 6;
  const cols = 4;
  const rows = Math.ceil(captures.length / cols);
  const gridW = cols * (cellW + gap) + gap;
  const gridH = rows * (cellH + labelH + gap) + gap;
  const composites = [];
  for (let i = 0; i < captures.length; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const x = gap + c * (cellW + gap);
    const y = gap + r * (cellH + labelH + gap);
    const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${labelH}"><rect width="100%" height="100%" fill="#1e1e24"/><text x="6" y="16" font-family="monospace" font-size="12" fill="#ffcc66">${captures[i].label}</text></svg>`;
    composites.push({ input: await sharp(Buffer.from(labelSvg)).png().toBuffer(), top: y, left: x });
    const buf = await sharp(captures[i].file).resize(cellW, cellH, { fit: 'contain', background: '#1a1a22' }).png().toBuffer();
    composites.push({ input: buf, top: y + labelH, left: x });
  }
  const gridPath = path.join(outDir, `pickups-${label}-grid.png`);
  await sharp({ create: { width: gridW, height: gridH, channels: 4, background: '#12121a' } })
    .composite(composites).png().toFile(gridPath);
  console.log(`\n[capture-pickups] grid → ${path.relative(ROOT, gridPath)}`);

  if (errors.length) {
    console.log('[capture-pickups] page errors:');
    errors.forEach(e => console.log('  ' + e));
  }
  await browser.close();
  server.close();
}

main().catch(e => { console.error('[capture-pickups] CRASHED:', e.message); process.exit(1); });
