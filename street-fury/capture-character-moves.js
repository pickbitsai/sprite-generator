/**
 * Full character-moveset review grid. Where capture-walks only shows the
 * 2-frame walk cycle, this one covers every state × every frame the engine
 * reads from REX_ANIMS — 27 cells per character, 4 characters = 108 cells.
 *
 * Grid structure: one section per character; within a section one row per
 * animation state with the frames for that state as columns. States match
 * REX_ANIMS in src/sprites.js.
 *
 * Usage:
 *   node tools/theme/capture-character-moves.js            # base
 *   node tools/theme/capture-character-moves.js neon_samurai
 *
 * Output:
 *   test-screenshots/character-moves-<theme|base>-<char>-<state>-f<N>.png
 *   test-screenshots/character-moves-<theme|base>-grid.png
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8785;
const MIME = { '.html':'text/html','.js':'text/javascript','.png':'image/png','.mp3':'audio/mp3','.wav':'audio/wav','.ogg':'audio/ogg','.json':'application/json' };

// State + frame count the engine actually reads (REX_ANIMS for all chars;
// themed chars fall through to REX_ANIMS at runtime).
const STATES = [
  { key: 'idle',       frames: 4 },
  { key: 'walk',       frames: 2 },   // themed is 2; base falls back to 5-6 but we only show first 2 here
  { key: 'attack1',    frames: 3 },
  { key: 'attack2',    frames: 3 },
  { key: 'attack3',    frames: 2 },
  { key: 'jump',       frames: 2 },
  { key: 'jumpAttack', frames: 2 },
  { key: 'special',    frames: 2 },
  { key: 'hurt',       frames: 2 },
  { key: 'knockdown',  frames: 2 },
  { key: 'dead',       frames: 1 },
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
  console.log(`[capture-character-moves] ${url}`);
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

  const characters = await page.evaluate(() => {
    // eslint-disable-next-line no-undef
    const C = typeof CHARACTERS !== 'undefined' ? CHARACTERS : [];
    return C.map(c => ({ name: c.name, id: c.id || c.spriteKey || c.name }));
  });
  console.log(`[capture-character-moves] characters: ${characters.map(c => c.name).join(', ')}`);

  const captures = {};
  for (let ci = 0; ci < characters.length; ci++) {
    const char = characters[ci];
    captures[ci] = {};
    for (const state of STATES) {
      captures[ci][state.key] = [];
      for (let f = 0; f < state.frames; f++) {
        const rect = await page.evaluate(({ ci, state, f }) => {
          const p = window.game.player;
          // eslint-disable-next-line no-undef
          p.charDef = CHARACTERS[ci];
          p.state = state; p.stateTimer = 999; p.animFrame = f; p.facing = 1;
          p.x = 192; p.y = 160;
          if (typeof window.game.render === 'function') window.game.render();
          const c = document.getElementById('gameCanvas');
          const cb = c.getBoundingClientRect();
          const cam = window.game.camera || { x: 0 };
          const sx = p.x - cam.x, sy = p.y;
          const scaleX = cb.width / 384, scaleY = cb.height / 224;
          const cw = 70, ch = 90;
          return {
            x: Math.round(cb.left + (sx - cw / 2) * scaleX),
            y: Math.round(cb.top + (sy - ch + 10) * scaleY),
            width: Math.round(cw * scaleX),
            height: Math.round(ch * scaleY),
          };
        }, { ci, state: state.key, f });
        const out = path.join(outDir, `character-moves-${label}-${char.id}-${state.key}-f${f}.png`);
        await page.screenshot({ path: out, clip: rect });
        captures[ci][state.key].push(out);
      }
      console.log(`  ${char.name.padEnd(16)} ${state.key.padEnd(11)} ${state.frames} frame(s)`);
    }
  }

  // Grid layout: per-character sections stacked vertically. Each section
  // has a 1-line char header, then one row per state with cells = frames.
  const cellW = 140, cellH = 170, labelW = 110, stateRowGap = 2, sectionGap = 12, charHeaderH = 28;
  const maxFrames = Math.max(...STATES.map(s => s.frames));
  const gridW = labelW + maxFrames * cellW + sectionGap;
  let gridH = sectionGap;
  for (let ci = 0; ci < characters.length; ci++) {
    gridH += charHeaderH + STATES.length * (cellH + stateRowGap) + sectionGap;
  }

  const composites = [];
  let y = sectionGap;
  for (let ci = 0; ci < characters.length; ci++) {
    // Character header bar.
    const headerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${gridW - sectionGap * 2}" height="${charHeaderH}"><rect width="100%" height="100%" fill="#2b2b3a"/><text x="10" y="${Math.floor(charHeaderH * 0.7)}" font-family="monospace" font-size="16" fill="#ffcc66" font-weight="bold">${characters[ci].name}</text></svg>`;
    composites.push({ input: await sharp(Buffer.from(headerSvg)).png().toBuffer(), top: y, left: sectionGap });
    y += charHeaderH;

    for (const state of STATES) {
      // State label.
      const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${labelW}" height="${cellH}"><rect width="100%" height="100%" fill="#1e1e24"/><text x="8" y="${Math.floor(cellH / 2) + 4}" font-family="monospace" font-size="12" fill="#ffcc66">${state.key}</text></svg>`;
      composites.push({ input: await sharp(Buffer.from(labelSvg)).png().toBuffer(), top: y, left: sectionGap });
      for (let f = 0; f < state.frames; f++) {
        const file = captures[ci][state.key][f];
        const frameBuf = await sharp(file).resize(cellW, cellH, { fit: 'contain', background: '#1a1a22' }).png().toBuffer();
        composites.push({ input: frameBuf, top: y, left: sectionGap + labelW + f * cellW });
      }
      y += cellH + stateRowGap;
    }
    y += sectionGap;
  }

  const gridPath = path.join(outDir, `character-moves-${label}-grid.png`);
  await sharp({ create: { width: gridW, height: gridH, channels: 4, background: '#12121a' } })
    .composite(composites).png().toFile(gridPath);
  console.log(`\n[capture-character-moves] grid → ${path.relative(ROOT, gridPath)}`);

  if (errors.length) {
    console.log('[capture-character-moves] page errors:');
    errors.forEach(e => console.log('  ' + e));
  }
  await browser.close();
  server.close();
}

main().catch(e => { console.error('[capture-character-moves] CRASHED:', e.message); process.exit(1); });
