/**
 * Capture each enemy type × each animation state side-by-side so you can
 * eyeball whether every frame reads the right cell. Catches "hurt renders
 * as attack-frame-2" type cropping bugs that static layout verification
 * can't distinguish from "cell has content" (it may have WRONG content).
 *
 * Usage:
 *   node tools/theme/capture-enemies.js            # base game
 *   node tools/theme/capture-enemies.js simpsons
 *
 * Output:
 *   test-screenshots/enemies-<theme|base>-<type>-<state>.png
 *   test-screenshots/enemies-<theme|base>-grid.png
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8777;
const MIME = { '.html':'text/html','.js':'text/javascript','.png':'image/png','.mp3':'audio/mp3','.wav':'audio/wav','.ogg':'audio/ogg','.json':'application/json' };

// The engine's ENEMY_ANIMS states we want to visually inspect. Skipping
// `cooldown` / `telegraph` because visually they overlap other states.
const STATES = ['idle', 'walk', 'approach', 'attack', 'hurt', 'dead'];

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
  console.log(`[capture-enemies] ${url}`);
  await page.goto(url);

  await page.waitForFunction(() => window.game && window.game.spritesReady, { timeout: 20000 });
  await page.locator('body').click({ force: true }).catch(() => {});
  async function tap(key) { await page.keyboard.down(key); await page.waitForTimeout(110); await page.keyboard.up(key); await page.waitForTimeout(110); }
  await tap('Enter'); await tap('Enter');
  await page.waitForFunction(() => window.game.scene === 'playing', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);

  // Freeze.
  await page.evaluate(() => {
    const g = window.game;
    g.__frozenUpdate = g.update;
    g.update = () => {};
    if (g.player) { g.player.__frozenUpdate = g.player.update; g.player.update = () => {}; }
    if (Array.isArray(g.enemies)) for (const e of g.enemies) { e.__frozenUpdate = e.update; e.update = () => {}; }
  });

  // Discover enemy type list + display names from the engine's own config.
  const types = await page.evaluate(() => {
    // eslint-disable-next-line no-undef
    const T = typeof ENEMY_TYPES !== 'undefined' ? ENEMY_TYPES : {};
    return Object.entries(T).map(([key, def]) => ({ key, name: def.name || key }));
  });
  console.log(`[capture-enemies] types: ${types.map(t => t.name).join(', ')}`);

  const captures = []; // { type, state, file }

  for (const t of types) {
    for (const state of STATES) {
      const rect = await page.evaluate(({ typeKey, state }) => {
        const g = window.game;
        // Remove existing enemies so only our probe subject is on screen
        g.enemies = [];
        // Enemy() takes a typeDef object, not a type key string. Pulled
        // from the global ENEMY_TYPES map.
        // eslint-disable-next-line no-undef
        const e = new Enemy(ENEMY_TYPES[typeKey], 220, 160);
        e.state = state;
        e.stateTimer = 999;
        e.animFrame = 6; // the engine does Math.floor(animFrame*0.1) so anim frame index = 0 at animFrame<10
        e.facing = -1;
        e.dying = state === 'dead';
        e.hp = state === 'dead' ? 0 : e.maxHp;
        e.flashTimer = 0;
        g.enemies.push(e);
        if (typeof g.render === 'function') g.render();
        const c = document.getElementById('gameCanvas');
        const cb = c.getBoundingClientRect();
        const cam = g.camera || { x: 0 };
        const sx = e.x - cam.x;
        const sy = e.y;
        const scaleX = cb.width / 384;
        const scaleY = cb.height / 224;
        const cw = 80, ch = 90;
        return {
          x: Math.round(cb.left + (sx - cw / 2) * scaleX),
          y: Math.round(cb.top + (sy - ch + 15) * scaleY),
          width: Math.round(cw * scaleX),
          height: Math.round(ch * scaleY),
        };
      }, { typeKey: t.key, state });
      const out = path.join(outDir, `enemies-${label}-${t.key}-${state}.png`);
      await page.screenshot({ path: out, clip: rect });
      captures.push({ type: t, state, file: out });
      console.log(`  ${t.name.padEnd(16)} ${state.padEnd(9)} → ${path.relative(ROOT, out)}`);
    }
  }

  // Compose a grid: rows = types, cols = states.
  const cellW = 180, cellH = 200, labelW = 120, headerH = 24, gap = 4;
  const gridW = labelW + STATES.length * (cellW + gap) + 10;
  const gridH = headerH + types.length * (cellH + gap) + 10;
  const composites = [];

  // Column headers (states).
  for (let s = 0; s < STATES.length; s++) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${headerH}"><rect width="100%" height="100%" fill="#1e1e24"/><text x="6" y="16" font-family="monospace" font-size="13" fill="#ffcc66">${STATES[s]}</text></svg>`;
    composites.push({ input: await sharp(Buffer.from(svg)).png().toBuffer(), top: 5, left: labelW + s * (cellW + gap) });
  }
  // Rows.
  for (let ti = 0; ti < types.length; ti++) {
    const rowY = headerH + 5 + ti * (cellH + gap);
    const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${labelW}" height="${cellH}"><rect width="100%" height="100%" fill="#1e1e24"/><text x="6" y="${Math.floor(cellH / 2)}" font-family="monospace" font-size="13" fill="#ffcc66">${types[ti].name}</text></svg>`;
    composites.push({ input: await sharp(Buffer.from(labelSvg)).png().toBuffer(), top: rowY, left: 5 });
    for (let s = 0; s < STATES.length; s++) {
      const hit = captures.find(c => c.type.key === types[ti].key && c.state === STATES[s]);
      if (!hit) continue;
      const buf = await sharp(hit.file).resize(cellW, cellH, { fit: 'contain', background: '#1a1a22' }).png().toBuffer();
      composites.push({ input: buf, top: rowY, left: labelW + s * (cellW + gap) });
    }
  }
  const gridPath = path.join(outDir, `enemies-${label}-grid.png`);
  await sharp({ create: { width: gridW, height: gridH, channels: 4, background: '#12121a' } })
    .composite(composites)
    .png()
    .toFile(gridPath);
  console.log(`\n[capture-enemies] grid → ${path.relative(ROOT, gridPath)}`);

  if (errors.length) {
    console.log('[capture-enemies] page errors:');
    errors.forEach(e => console.log('  ' + e));
  }

  await browser.close();
  server.close();
}

main().catch(e => { console.error('[capture-enemies] CRASHED:', e.message); process.exit(1); });
