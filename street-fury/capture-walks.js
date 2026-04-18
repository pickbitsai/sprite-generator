/**
 * Capture each character's walk-cycle frames side-by-side for visual
 * validation. Works for both base game and themed variants — pass a theme
 * id or nothing.
 *
 * For each of the game's 4 characters, it:
 *   1. Boots the game in Playwright, drives title → select → playing
 *   2. Forces game.player to the target charIndex
 *   3. Freezes update loops so animFrame stays where we put it
 *   4. Renders frame 0 and frame 1 of the walk cycle
 *   5. Screenshots each, plus composes a combined strip
 *
 * Usage:
 *   node tools/theme/capture-walks.js            # base game (no theme)
 *   node tools/theme/capture-walks.js simpsons   # themed
 *
 * Output:
 *   test-screenshots/walks-<theme|base>-<charIndex>-<charName>-f{0,1}.png
 *   test-screenshots/walks-<theme|base>-strip.png   # 4-char × 2-frame grid
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8776;
const MIME = { '.html':'text/html','.js':'text/javascript','.png':'image/png','.mp3':'audio/mp3','.wav':'audio/wav','.ogg':'audio/ogg','.json':'application/json' };

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
  console.log(`[capture-walks] ${url}`);
  await page.goto(url);

  await page.waitForFunction(() => window.game && window.game.spritesReady, { timeout: 20000 });
  await page.locator('body').click({ force: true }).catch(() => {});
  async function tap(key) { await page.keyboard.down(key); await page.waitForTimeout(110); await page.keyboard.up(key); await page.waitForTimeout(110); }
  await tap('Enter'); await tap('Enter');
  await page.waitForFunction(() => window.game.scene === 'playing', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);

  // Freeze update loops.
  await page.evaluate(() => {
    const g = window.game;
    g.__frozenUpdate = g.update;
    g.update = () => {};
    if (g.player) { g.player.__frozenUpdate = g.player.update; g.player.update = () => {}; }
  });

  // Top-level `const` in script-tag scripts isn't attached to window, but
  // it IS reachable from Playwright's evaluate sandbox by bare name.
  const characters = await page.evaluate(() => {
    // eslint-disable-next-line no-undef
    const C = typeof CHARACTERS !== 'undefined' ? CHARACTERS : [];
    return C.map(c => ({ name: c.name, id: c.id || c.spriteKey || c.name }));
  });
  console.log(`[capture-walks] characters: ${characters.map(c => c.name).join(', ')}`);

  const perChar = [];
  for (let ci = 0; ci < characters.length; ci++) {
    const char = characters[ci];
    const frames = [];
    for (let f = 0; f < 2; f++) {
      const rect = await page.evaluate(({ ci, f }) => {
        const p = window.game.player;
        // Swap this existing player's charDef to the target character (keeps
        // all other init state valid — bypasses the Player() constructor
        // edge cases that bit us when reconstructing from scratch).
        // eslint-disable-next-line no-undef
        p.charDef = CHARACTERS[ci];
        p.state = 'walk';
        p.stateTimer = 999;
        p.animFrame = f;
        p.facing = 1;
        p.x = 192;
        p.y = 160;
        if (typeof window.game.render === 'function') window.game.render();
        const c = document.getElementById('gameCanvas');
        const cb = c.getBoundingClientRect();
        const cam = window.game.camera || { x: 0 };
        const sx = p.x - cam.x;
        const sy = p.y;
        const scaleX = cb.width / 384;
        const scaleY = cb.height / 224;
        const cw = 90, ch = 105;
        return {
          x: Math.round(cb.left + (sx - cw / 2) * scaleX),
          y: Math.round(cb.top + (sy - ch + 15) * scaleY),
          width: Math.round(cw * scaleX),
          height: Math.round(ch * scaleY),
        };
      }, { ci, f });
      const out = path.join(outDir, `walks-${label}-${ci}-${char.id}-f${f}.png`);
      await page.screenshot({ path: out, clip: rect });
      frames.push(out);
      console.log(`  ${char.name.padEnd(18)} f${f} → ${path.relative(ROOT, out)}`);
    }
    perChar.push({ char, frames });
  }

  // Compose a grid: 4 characters × 2 frames, labels above each row.
  const cellW = 240, cellH = 280, labelH = 24, gap = 6;
  const gridW = 2 * cellW + gap + 10;
  const gridH = characters.length * (cellH + labelH + gap) + 10;
  const composites = [];
  for (let i = 0; i < perChar.length; i++) {
    const { frames, char } = perChar[i];
    const rowY = 5 + i * (cellH + labelH + gap);
    // Label strip: render text to SVG → PNG.
    const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${gridW - 10}" height="${labelH}"><rect width="100%" height="100%" fill="#1e1e24"/><text x="6" y="17" font-family="monospace" font-size="14" fill="#ffcc66">${char.name}</text></svg>`;
    const labelBuf = await sharp(Buffer.from(labelSvg)).png().toBuffer();
    composites.push({ input: labelBuf, top: rowY, left: 5 });
    for (let f = 0; f < 2; f++) {
      const frameBuf = await sharp(frames[f]).resize(cellW, cellH, { fit: 'contain', background: '#1a1a22' }).png().toBuffer();
      composites.push({ input: frameBuf, top: rowY + labelH, left: 5 + f * (cellW + gap) });
    }
  }
  const gridPath = path.join(outDir, `walks-${label}-strip.png`);
  await sharp({ create: { width: gridW, height: gridH, channels: 4, background: '#12121a' } })
    .composite(composites)
    .png()
    .toFile(gridPath);
  console.log(`\n[capture-walks] grid → ${path.relative(ROOT, gridPath)}`);

  if (errors.length) {
    console.log('[capture-walks] page errors:');
    errors.forEach(e => console.log('  ' + e));
  }

  await browser.close();
  server.close();
}

main().catch(e => { console.error('[capture-walks] CRASHED:', e.message); process.exit(1); });
