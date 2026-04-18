/**
 * Capture character select + gameplay screenshots for a theme, then
 * stitch them into a single review sheet PNG for visual sign-off.
 *
 * Output: test-screenshots/review-<theme>-sizing.png
 *
 * Usage:
 *   node tools/theme/capture-character-select.js <theme-id|base>
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8775;
const MIME = { '.html':'text/html','.js':'text/javascript','.png':'image/png','.mp3':'audio/mp3' };

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
  const args = process.argv.slice(2);
  const themeId = args.find(a => !a.startsWith('-')) || 'base';
  const isBase = themeId === 'base';
  const label = isBase ? 'base' : themeId;
  const ssDir = path.join(ROOT, 'test-screenshots');
  fs.mkdirSync(ssDir, { recursive: true });

  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });

  const url = isBase
    ? `http://localhost:${PORT}/index.html`
    : `http://localhost:${PORT}/index.html?theme=${themeId}`;
  console.log(`[capture-character-select] ${url}`);
  await page.goto(url);
  await page.waitForFunction(() => window.game && window.game.spritesReady, { timeout: 20000 });

  // ── 1. Character select screen ──
  await page.evaluate(() => {
    window.game.scene = 'select';
    window.game.selectedCharacter = 0;
  });
  await page.waitForTimeout(400);
  const selectPath = path.join(ssDir, `sizing-${label}-select.png`);
  await page.screenshot({ path: selectPath });
  console.log(`  select screen captured`);

  // ── 2. Gameplay with enemies for size comparison ──
  await page.evaluate(() => {
    window.game.selectedCharacter = 0;
    window.game.startGame();
    window.game.scene = 'playing';
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const g = window.game;
    g.player.x = 200;
    g.camera.x = 100; g.camera.targetX = 100;
    g.enemies = [
      new Enemy(ENEMY_TYPES.basic, 250, g.player.y, false),
      new Enemy(ENEMY_TYPES.heavy, 300, g.player.y, false),
      new Enemy(ENEMY_TYPES.rusher, 270, g.player.y + 20, false),
    ];
  });
  await page.waitForTimeout(500);
  const gameplayPath = path.join(ssDir, `sizing-${label}-gameplay.png`);
  await page.screenshot({ path: gameplayPath });
  console.log(`  gameplay captured`);

  await browser.close();
  server.close();

  // ── 3. Stitch into review sheet ──
  const THUMB_W = 640, THUMB_H = 360;
  const HEADER_H = 32, PAD = 8;
  const TOTAL_W = PAD + (THUMB_W + PAD) * 2;
  const TOTAL_H = PAD + HEADER_H + THUMB_H + PAD;

  const title = isBase ? 'BASE GAME' : label.toUpperCase().replace(/_/g, ' ');
  const headerSvg = Buffer.from(
    `<svg width="${TOTAL_W}" height="${HEADER_H}">` +
    `<rect width="100%" height="100%" fill="#1a1a2e"/>` +
    `<text x="${TOTAL_W/2}" y="22" text-anchor="middle" ` +
    `font-family="monospace" font-size="18" font-weight="bold" fill="#ffdd44">` +
    `${title}</text></svg>`
  );

  const composites = [{ input: headerSvg, top: PAD, left: 0 }];
  const thumbY = PAD + HEADER_H;
  const files = [selectPath, gameplayPath];
  const labels = ['CHARACTER SELECT', 'GAMEPLAY'];

  for (let c = 0; c < 2; c++) {
    const x0 = PAD + c * (THUMB_W + PAD);
    if (!fs.existsSync(files[c])) continue;
    const thumb = await sharp(files[c])
      .resize(THUMB_W, THUMB_H, { fit: 'cover' })
      .png().toBuffer();
    composites.push({ input: thumb, top: thumbY, left: x0 });

    const labelSvg = Buffer.from(
      `<svg width="${THUMB_W}" height="20">` +
      `<rect width="100%" height="100%" fill="rgba(0,0,0,0.6)" rx="3"/>` +
      `<text x="${THUMB_W/2}" y="14" text-anchor="middle" ` +
      `font-family="monospace" font-size="11" fill="#aaaaaa">${labels[c]}</text></svg>`
    );
    composites.push({ input: labelSvg, top: thumbY + THUMB_H - 20, left: x0 });
  }

  const outPath = path.join(ssDir, `review-${label}-sizing.png`);
  await sharp({
    create: { width: TOTAL_W, height: TOTAL_H, channels: 4,
              background: { r: 10, g: 10, b: 20, alpha: 255 } }
  }).composite(composites).png().toFile(outPath);

  console.log(`\n  Review sheet: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
