/**
 * Final stage: in-browser gameplay verification.
 *
 * Loads the themed game under Playwright, forces the player into every
 * animation state × every frame index, screenshots the player crop, and
 * verifies each capture has non-trivial opaque pixels. That catches bugs
 * that static sheet analysis can't: wrong frame size, off-by-one cell
 * lookup, walk strip mis-scaling, etc.
 *
 * Usage:
 *   node tools/theme/verify-gameplay.js <theme-id>
 *   node tools/theme/verify-gameplay.js <theme-id> --screenshots   # also
 *                                                                   # write
 *                                                                   # every
 *                                                                   # crop
 *
 * Exit code: 0 if every animation × frame renders non-empty, 2 otherwise.
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { parseThemeIdFromArgs } = require('./lib');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8773;
const MIME = { '.html':'text/html','.js':'text/javascript','.png':'image/png','.mp3':'audio/mp3','.wav':'audio/wav','.ogg':'audio/ogg','.json':'application/json' };

const PLAYER_ANIMS = ['idle', 'walk', 'attack1', 'attack2', 'attack3', 'jump', 'jumpAttack', 'hurt', 'knockdown', 'dead', 'special'];
const MIN_OPAQUE_PX = 150; // fewer than this = "nothing visible" at the player's on-screen size

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const p = path.join(ROOT, url === '/' ? 'index.html' : url);
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
});

async function cropOpaqueCount(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    if (data[i * info.channels + (info.channels - 1)] > 30) n++;
  }
  return n;
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const writeScreenshots = process.argv.includes('--screenshots');
  fs.mkdirSync(path.join(ROOT, 'test-screenshots'), { recursive: true });

  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });

  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

  const url = `http://localhost:${PORT}/index.html?theme=${themeId}`;
  console.log(`[verify-gameplay] ${url}`);
  await page.goto(url);

  await page.waitForFunction(() => window.game && window.game.spritesReady, { timeout: 20000 });
  await page.locator('body').click({ force: true }).catch(() => {});

  async function tap(key) {
    await page.keyboard.down(key);
    await page.waitForTimeout(110);
    await page.keyboard.up(key);
    await page.waitForTimeout(110);
  }
  await tap('Enter'); await tap('Enter');
  await page.waitForFunction(() => window.game.scene === 'playing', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);

  // Freeze the game loop. We want deterministic render() calls against
  // forced player state — without this, the RAF loop overwrites animFrame
  // between set and screenshot, so every capture lands on whatever frame
  // the engine happens to be rendering.
  await page.evaluate(() => {
    const g = window.game;
    g.__frozenUpdate = g.update;
    g.update = () => {};
    if (g.player) {
      g.player.__frozenUpdate = g.player.update;
      g.player.update = () => {};
    }
  });

  // Force the player into (state, frame) deterministically via evaluate().
  // We also lock `updateState` for one tick by using a frozen animFrame.
  async function probeFrame(state, animFrameValue) {
    const rect = await page.evaluate(({ state, animFrameValue }) => {
      const p = window.game.player;
      if (!p) return null;
      p.state = state;
      p.animFrame = animFrameValue;
      p.stateTimer = 20; // keep the state alive
      p.vy = (state === 'jump' || state === 'jumpAttack') ? -1 : 0;
      if (state === 'jump' || state === 'jumpAttack') p.y = Math.min(p.y, 150);
      // Force a render frame. game-engine.js exposes `render()`, not `draw()`.
      const game = window.game;
      if (typeof game.render === 'function') game.render();
      const c = document.getElementById('gameCanvas');
      const cb = c.getBoundingClientRect();
      const cam = game.camera || { x: 0 };
      const sx = p.x - cam.x;
      const sy = p.y;
      const scaleX = cb.width / 384;
      const scaleY = cb.height / 224;
      const cw = 80, ch = 90;
      return {
        x: Math.round(cb.left + (sx - cw / 2) * scaleX),
        y: Math.round(cb.top + (sy - ch + 15) * scaleY),
        width: Math.round(cw * scaleX),
        height: Math.round(ch * scaleY),
      };
    }, { state, animFrameValue });
    if (!rect) return { ok: false, reason: 'no player' };
    const buf = await page.screenshot({ clip: rect });
    const opaque = await cropOpaqueCount(buf);
    if (writeScreenshots) {
      const out = path.join(ROOT, 'test-screenshots', `verify-${themeId}-${state}-f${Math.floor(animFrameValue)}.png`);
      fs.writeFileSync(out, buf);
    }
    return { ok: opaque >= MIN_OPAQUE_PX, opaque };
  }

  // animFrame is a float counter that's multiplied by animSpeed in draw().
  // For most states animSpeed is 1.0, so integer animFrame values land on
  // successive frames. We probe 0..N-1 where N is the frames count per anim.
  const FRAME_COUNTS = {
    idle: 4, walk: 4, attack1: 3, attack2: 3, attack3: 2,
    jump: 2, jumpAttack: 2, hurt: 2, knockdown: 2, dead: 1, special: 2,
  };

  let total = 0, failed = 0;
  const failures = [];
  for (const state of PLAYER_ANIMS) {
    const n = FRAME_COUNTS[state] || 1;
    for (let f = 0; f < n; f++) {
      total++;
      const r = await probeFrame(state, f);
      if (!r.ok) {
        failed++;
        failures.push({ state, frame: f, reason: r.reason || `only ${r.opaque} opaque px` });
      }
    }
  }

  console.log(`[verify-gameplay] probed ${total} state×frame combos.  ok=${total - failed}  fail=${failed}`);
  if (failures.length) {
    for (const f of failures) console.log(`  ${f.state} frame ${f.frame}: ${f.reason}`);
  }
  if (pageErrors.length) {
    console.log('[verify-gameplay] page errors:');
    pageErrors.forEach(e => console.log('  ' + e));
  }

  await browser.close();
  server.close();

  if (failed > 0 || pageErrors.length > 0) {
    console.log('[verify-gameplay] FAILED.');
    process.exit(2);
  }
  console.log('[verify-gameplay] PASSED.');
}

if (require.main === module) {
  main().catch(e => { console.error('[verify-gameplay] CRASHED:', e.message); process.exit(1); });
}

module.exports = { main };
