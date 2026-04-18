/**
 * Visual grid export for bosses: each of the 3 bosses × a shared subset of
 * animation states (idle/walk/attack/hurt/dead). Same pattern as
 * capture-walks.js and capture-enemies.js — produces one labelled PNG
 * grid you can eyeball to confirm bosses render from the correct cells
 * of their respective sheets.
 *
 * Usage:
 *   node tools/theme/capture-bosses.js            # base
 *   node tools/theme/capture-bosses.js simpsons
 *
 * Output:
 *   test-screenshots/bosses-<theme|base>-<type>-<state>.png
 *   test-screenshots/bosses-<theme|base>-grid.png
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8780;
const MIME = { '.html':'text/html','.js':'text/javascript','.png':'image/png','.mp3':'audio/mp3','.wav':'audio/wav','.ogg':'audio/ogg','.json':'application/json' };

const BOSS_TYPES = ['street_brawler', 'tech_boss', 'final_boss'];
// States that exist (or alias to a populated cell) on every boss — themed
// bossAnims in build-config.js aliases attack/attack1/attack2/special/etc.
// Base game resolves these via BOSS1/BOSS2/BOSS3 ANIMS with graceful
// fallbacks (most states degrade to idle if not in the boss's ANIMS map).
const STATES = ['idle', 'walk', 'attack', 'attack2', 'special', 'hurt', 'dead'];

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
  console.log(`[capture-bosses] ${url}`);
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

  // Boss display names from config where available, else slot-numbered.
  const bossNames = await page.evaluate(() => {
    const t = window.THEME;
    const n = ['Street Brawler', 'Tech Boss', 'Final Boss'];
    if (t && Array.isArray(t.bossDefs)) return t.bossDefs.map((d, i) => d.name || n[i]);
    if (t && Array.isArray(t.bosses)) return t.bosses.map((d, i) => d.name || n[i]);
    return n;
  });

  const captures = [];
  for (let i = 0; i < BOSS_TYPES.length; i++) {
    for (const state of STATES) {
      const rect = await page.evaluate(({ bossType, state }) => {
        const g = window.game;
        g.enemies = []; g.boss = null;
        // eslint-disable-next-line no-undef
        const b = new Boss(bossType, 220, 160);
        b.state = state; b.stateTimer = 999; b.animFrame = 8; b.facing = -1;
        b.dying = state === 'dead';
        // boss.js blinks the sprite during dying (dyingTimer % 6 < 3 skips
        // the draw). Put us on a "draw" tick or the dead cell comes out
        // blank in the grid.
        b.dyingTimer = 3;
        b.dead = false;
        b.hp = state === 'dead' ? 0 : b.maxHp;
        b.flashTimer = 0;
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
        const cw = 110, ch = 130;
        return {
          x: Math.round(cb.left + (sx - cw / 2) * scaleX),
          y: Math.round(cb.top + (sy - ch + 10) * scaleY),
          width: Math.round(cw * scaleX),
          height: Math.round(ch * scaleY),
        };
      }, { bossType: BOSS_TYPES[i], state });
      const out = path.join(outDir, `bosses-${label}-${BOSS_TYPES[i]}-${state}.png`);
      await page.screenshot({ path: out, clip: rect });
      captures.push({ typeIdx: i, name: bossNames[i] || BOSS_TYPES[i], state, file: out });
      console.log(`  ${(bossNames[i] || BOSS_TYPES[i]).padEnd(22)} ${state.padEnd(7)} → ${path.relative(ROOT, out)}`);
    }
  }

  // Grid: rows = bosses, cols = states.
  const cellW = 200, cellH = 230, labelW = 130, headerH = 24, gap = 4;
  const gridW = labelW + STATES.length * (cellW + gap) + 10;
  const gridH = headerH + BOSS_TYPES.length * (cellH + gap) + 10;
  const composites = [];

  for (let s = 0; s < STATES.length; s++) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${headerH}"><rect width="100%" height="100%" fill="#1e1e24"/><text x="6" y="16" font-family="monospace" font-size="13" fill="#ffcc66">${STATES[s]}</text></svg>`;
    composites.push({ input: await sharp(Buffer.from(svg)).png().toBuffer(), top: 5, left: labelW + s * (cellW + gap) });
  }
  for (let i = 0; i < BOSS_TYPES.length; i++) {
    const rowY = headerH + 5 + i * (cellH + gap);
    const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${labelW}" height="${cellH}"><rect width="100%" height="100%" fill="#1e1e24"/><text x="6" y="${Math.floor(cellH / 2)}" font-family="monospace" font-size="13" fill="#ffcc66">${bossNames[i] || BOSS_TYPES[i]}</text></svg>`;
    composites.push({ input: await sharp(Buffer.from(labelSvg)).png().toBuffer(), top: rowY, left: 5 });
    for (let s = 0; s < STATES.length; s++) {
      const hit = captures.find(c => c.typeIdx === i && c.state === STATES[s]);
      if (!hit) continue;
      const buf = await sharp(hit.file).resize(cellW, cellH, { fit: 'contain', background: '#1a1a22' }).png().toBuffer();
      composites.push({ input: buf, top: rowY, left: labelW + s * (cellW + gap) });
    }
  }
  const gridPath = path.join(outDir, `bosses-${label}-grid.png`);
  await sharp({ create: { width: gridW, height: gridH, channels: 4, background: '#12121a' } })
    .composite(composites).png().toFile(gridPath);
  console.log(`\n[capture-bosses] grid → ${path.relative(ROOT, gridPath)}`);

  if (errors.length) {
    console.log('[capture-bosses] page errors:');
    errors.forEach(e => console.log('  ' + e));
  }
  await browser.close();
  server.close();
}

main().catch(e => { console.error('[capture-bosses] CRASHED:', e.message); process.exit(1); });
